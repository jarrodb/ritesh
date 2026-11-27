package server

import (
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
)

// maxLinks is how many symbolic links one path may pass through.
const maxLinks = 40

var (
	errEscape = errors.New("link leaves the mount")
	errLoop   = errors.New("too many links")
)

// mount is one file system and where it sits under the remote's root.
type mount struct {
	// at is "" for the root, or a slash-separated path without a leading or
	// trailing slash.
	at   string
	fsys fs.FS
}

// mounts is ordered longest path first, so the first match is the deepest.
type mounts []mount

// cleanMountPath turns "/", "/docs", or "docs/" into "", "docs", "docs".
func cleanMountPath(p string) (string, bool) {
	p = strings.Trim(p, "/")
	if p == "" {
		return "", true
	}
	return p, fs.ValidPath(p) && p != "." && !strings.ContainsRune(p, 0)
}

func (ms mounts) add(m mount) mounts {
	out := append(slices.Clone(ms), m)
	slices.SortStableFunc(out, func(a, b mount) int { return len(b.at) - len(a.at) })
	return out
}

func (ms mounts) has(at string) bool {
	return slices.ContainsFunc(ms, func(m mount) bool { return m.at == at })
}

// find returns the mount that serves p and p's name inside it. When no mount
// serves p, virtual reports whether p is a directory above some mount.
func (ms mounts) find(p string) (m mount, name string, virtual, ok bool) {
	for _, m := range ms {
		switch {
		case m.at == "":
			if p == "" {
				return m, ".", false, true
			}
			return m, p, false, true
		case p == m.at:
			return m, ".", false, true
		case strings.HasPrefix(p, m.at+"/"):
			return m, p[len(m.at)+1:], false, true
		}
	}
	return mount{}, "", len(ms.below(p)) > 0 || p == "", false
}

// below returns the names directly under p that lead to a mount.
func (ms mounts) below(p string) []string {
	var names []string
	for _, m := range ms {
		rest, ok := m.at, m.at != ""
		if p != "" {
			rest, ok = strings.CutPrefix(m.at, p+"/")
		}
		if !ok {
			continue
		}
		name, _, _ := strings.Cut(rest, "/")
		if !slices.Contains(names, name) {
			names = append(names, name)
		}
	}
	return names
}

// checkPath validates a path from the client. The root is "". Segments are
// separated by "/"; "..", ".", an empty segment, and NUL are refused.
func (l Limits) checkPath(p string) *rpcError {
	if len(p) > l.MaxPathBytes {
		// Too long to send back.
		return appError(einval)
	}
	if p == "" {
		return nil
	}
	if strings.ContainsRune(p, 0) || p == "." || !fs.ValidPath(p) {
		return pathError(einval, p)
	}
	return nil
}

// confine resolves the symbolic links in name against fsys and returns a name
// free of links. A link whose target is absolute or climbs above the root of
// fsys is refused, so no request follows a link out of the mount. A file
// system that does not report links (fs.ReadLinkFS) is taken to have none
// that leave it.
func confine(fsys fs.FS, name string) (string, error) {
	links, ok := fsys.(fs.ReadLinkFS)
	if !ok || name == "." {
		return name, nil
	}
	todo := strings.Split(name, "/")
	done := "."
	for followed := 0; len(todo) > 0; {
		seg := todo[0]
		todo = todo[1:]
		switch seg {
		case "", ".":
			continue
		case "..":
			if done == "." {
				return "", errEscape
			}
			done = path.Dir(done)
			continue
		}
		next := path.Join(done, seg)
		info, err := links.Lstat(next)
		if err != nil {
			return "", err
		}
		if info.Mode()&fs.ModeSymlink == 0 {
			done = next
			continue
		}
		if followed++; followed > maxLinks {
			return "", errLoop
		}
		target, err := links.ReadLink(next)
		if err != nil {
			return "", err
		}
		if filepath.IsAbs(target) || filepath.VolumeName(target) != "" {
			return "", errEscape
		}
		target = filepath.ToSlash(target)
		if path.IsAbs(target) {
			return "", errEscape
		}
		todo = append(strings.Split(target, "/"), todo...)
	}
	return done, nil
}

// fail maps an error from a file system to what the client sees. The error's
// own text stays on the server, in the log when it is not one of the usual
// ones.
func (f fileSystem) fail(err error, p string) *rpcError {
	switch {
	case errors.Is(err, errEscape):
		return pathError(eacces, p)
	case errors.Is(err, errLoop):
		return pathError(eloop, p)
	case errors.Is(err, fs.ErrNotExist):
		return pathError(enoent, p)
	case errors.Is(err, fs.ErrPermission):
		return pathError(eacces, p)
	case errors.Is(err, syscall.ENOTDIR):
		return pathError(enotdir, p)
	case errors.Is(err, syscall.EISDIR):
		return pathError(eisdir, p)
	case errors.Is(err, fs.ErrInvalid):
		return pathError(einval, p)
	}
	f.log.Warn("rite file system error", slog.String("path", p), slog.Any("error", err))
	return pathError(eio, p)
}

type statResult struct {
	Type  string `json:"type"`
	Size  int64  `json:"size"`
	Mode  uint32 `json:"mode"`
	Mtime int64  `json:"mtime"`
}

type listEntry struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type listResult struct {
	Entries   []listEntry `json:"entries"`
	Truncated bool        `json:"truncated"`
}

type readResult struct {
	Data string `json:"data"`
	EOF  bool   `json:"eof"`
}

const (
	typeDir  = "dir"
	typeFile = "file"
)

var virtualDir = statResult{Type: typeDir, Mode: 0o555}

// wireType names a file mode, or returns "" for what rite.1 does not serve:
// devices, sockets, pipes.
func wireType(mode fs.FileMode) string {
	switch {
	case mode.IsDir():
		return typeDir
	case mode.IsRegular():
		return typeFile
	}
	return ""
}

// fileSystem answers the fs methods from a set of mounts.
type fileSystem struct {
	mounts mounts
	limits Limits
	log    *slog.Logger
}

// lookup resolves p to a file inside a mount and its info. virtual is true
// for a directory that exists only as the parent of a mount.
func (f fileSystem) lookup(p string) (m mount, name string, info fs.FileInfo, virtual bool, rerr *rpcError) {
	if rerr := f.limits.checkPath(p); rerr != nil {
		return mount{}, "", nil, false, rerr
	}
	m, name, virtual, ok := f.mounts.find(p)
	if !ok {
		if virtual {
			return mount{}, "", nil, true, nil
		}
		return mount{}, "", nil, false, pathError(enoent, p)
	}
	name, err := confine(m.fsys, name)
	if err != nil {
		return mount{}, "", nil, false, f.fail(err, p)
	}
	info, err = fs.Stat(m.fsys, name)
	if err != nil {
		return mount{}, "", nil, false, f.fail(err, p)
	}
	if wireType(info.Mode()) == "" {
		return mount{}, "", nil, false, pathError(enotsup, p)
	}
	return m, name, info, false, nil
}

func (f fileSystem) stat(p string) (statResult, *rpcError) {
	_, _, info, virtual, rerr := f.lookup(p)
	if rerr != nil {
		return statResult{}, rerr
	}
	if virtual {
		return virtualDir, nil
	}
	res := statResult{Type: wireType(info.Mode()), Mode: uint32(info.Mode().Perm())}
	if !info.IsDir() {
		res.Size = info.Size()
	}
	if t := info.ModTime(); !t.IsZero() {
		res.Mtime = t.UnixMilli()
	}
	return res, nil
}

func (f fileSystem) list(p string) (listResult, *rpcError) {
	m, name, info, virtual, rerr := f.lookup(p)
	if rerr != nil {
		return listResult{}, rerr
	}
	types := make(map[string]string)
	more := false
	if !virtual {
		if !info.IsDir() {
			return listResult{}, pathError(enotdir, p)
		}
		var err error
		if more, err = f.readDir(m, name, types); err != nil {
			return listResult{}, f.fail(err, p)
		}
	}
	// A mount covers whatever its parent holds under the same name.
	for _, child := range f.mounts.below(p) {
		types[child] = typeDir
	}

	names := make([]string, 0, len(types))
	for n := range types {
		names = append(names, n)
	}
	slices.Sort(names)
	res := listResult{Entries: []listEntry{}, Truncated: more}
	size := 0
	for _, n := range names {
		e := listEntry{Name: n, Type: types[n]}
		size += len(encode(e)) + 1
		if len(res.Entries) == f.limits.MaxListEntries || size > f.limits.payloadBudget() {
			res.Truncated = true
			break
		}
		res.Entries = append(res.Entries, e)
	}
	return res, nil
}

// readDir fills types with at most MaxListEntries+1 entries of a directory
// and reports whether it left some unread.
func (f fileSystem) readDir(m mount, name string, types map[string]string) (more bool, err error) {
	file, err := m.fsys.Open(name)
	if err != nil {
		return false, err
	}
	defer func() { _ = file.Close() }()
	dir, ok := file.(fs.ReadDirFile)
	if !ok {
		return false, syscall.ENOTDIR
	}
	entries, err := dir.ReadDir(f.limits.MaxListEntries + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return false, err
	}
	for _, e := range entries {
		mode := e.Type()
		if mode&fs.ModeSymlink != 0 {
			// Report what the link leads to, when it stays inside the mount.
			target, err := confine(m.fsys, path.Join(name, e.Name()))
			if err != nil {
				continue
			}
			info, err := fs.Stat(m.fsys, target)
			if err != nil {
				continue
			}
			mode = info.Mode()
		}
		if t := wireType(mode); t != "" {
			types[e.Name()] = t
		}
	}
	return len(entries) > f.limits.MaxListEntries, nil
}

// read returns up to length bytes of a file from offset, as text. Offsets
// count bytes. A read ends on a code point boundary, so the next offset is
// the previous one plus the UTF-8 length of data, as long as the file is
// valid UTF-8.
func (f fileSystem) read(p string, offset int64, length *int64) (readResult, *rpcError) {
	m, name, info, virtual, rerr := f.lookup(p)
	if rerr != nil {
		return readResult{}, rerr
	}
	if virtual || info.IsDir() {
		return readResult{}, pathError(eisdir, p)
	}
	want := f.limits.MaxReadBytes
	if length != nil {
		want = min(want, *length)
	}

	file, err := m.fsys.Open(name)
	if err != nil {
		return readResult{}, f.fail(err, p)
	}
	defer func() { _ = file.Close() }()
	if err := skip(file, offset); err != nil {
		if offset > info.Size() {
			// Some files refuse to seek past their end.
			return readResult{EOF: true}, nil
		}
		return readResult{}, f.fail(err, p)
	}
	// Read past the end of the range to see whether its last code point is
	// whole and whether the file ends there.
	buf := make([]byte, want+utfLookahead)
	n, err := io.ReadFull(file, buf)
	atEOF := errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
	if err != nil && !atEOF {
		return readResult{}, f.fail(err, p)
	}
	buf = buf[:n]

	for {
		cut := cutText(buf, want)
		res := readResult{Data: validText(buf[:cut]), EOF: atEOF && cut == int64(len(buf))}
		// Escapes and replacements can make the text longer than its bytes.
		if cut <= 1 || len(encode(res)) <= f.limits.payloadBudget() {
			return res, nil
		}
		want = cut / 2
	}
}

const utfLookahead = 4

// skip moves file to offset.
func skip(file fs.File, offset int64) error {
	if offset == 0 {
		return nil
	}
	if s, ok := file.(io.Seeker); ok {
		_, err := s.Seek(offset, io.SeekStart)
		return err
	}
	_, err := io.CopyN(io.Discard, file, offset)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}
