/// essentials
/// - Implement:
///    cat, cp, date, echo,
///    hostname, ls, mkdir,
///    more, mv, pwd, uname,
///    rmdir, bash, su, rm
///
/// - Not fully: df, dd, dmesg, ps, kill, mount, ps, umount,
/// - Not yet: chgrp, chmod, chown, ln, login, more,

/// Objects

var Host = function(terminal, kwargs) {
    kwargs = (!kwargs) ? {} : kwargs

    if (!terminal)
        return {'error': 'termlib.js Terminal required'}

    //
    this.name = kwargs.name ? kwargs.name : 'ipsh'; // hostname
    this.kernel = new Kernel(terminal, {});

    this.motd = [
        '******* MOTD ********',
        ' '
    ];

    // essentials
    this.kernel.fs.add_inodes([
        amber, bash, cat, cd, df, echo, exit, help,
        id, ls, make, mkdir, pwd, rm, sudo, touch, vim
    ]);

}; Host.prototype = {
    //public:
    inputHandler: function(input, ctrl) {
        input[0] = (input[0]) ? input[0].replace("^\.\/","") : input[0];
        this.kernel.input(input);
    },

    write: function(output) {
        this.kernel.terminal.write(output); // simple wrapper
    },

    motd: function() {
        this.kernel.terminal.write('**** MOTD ****');
    },

    _blank: false
}

var Kernel = function(terminal, kwargs) {
    kwargs = (!kwargs) ? {} : kwargs

    this.terminal = terminal;
    this.fs = new Filesystem();
    this.user = new User();
    this.name = 'jarrod';

    // fileskeleton
    this.mkdir('bin','/');
    this.mkdir('root','/');
    this.mkdir('home','/');
    this.mkdir('guest','/home/');

    // user init
    this.user.homedir = '/home/guest/';
    this.user.pwd = this.user.homedir;

}; Kernel.prototype = {
    //public:
    input: function(input, ctrl) {
        var show_prompt = true;
        var append = false;

        switch(this.terminal.inputChar) {
            case termKey.ETX:
                //this.terminal.close(); // ^C
                break;
            case termKey.NAK: //^U
                show_prompt = false;
                this.terminal._clearLine();
                break;
            case termKey.EOT: //^D
                this._command(['exit']);
                break;
            case termKey.SO: //^N
                if (this.terminal.closed) {
                    this.terminal.open();
                    this.terminal.clear();
                }
                break;
            case termKey.SOH: //^A
                show_prompt = false;
                for (var c=0; c<this.terminal._getLine().length; c++)
                    this.terminal.cursorLeft();
                break;
            case termKey.ENQ: //^E
                show_prompt = false;
                for (var c=0; c<this.terminal._getLine().length; c++)
                    this.terminal.cursorRight();
                break;
            case termKey.ETB: //^W
                show_prompt = false;
                var buffer = this.terminal._getLine();
                var name = buffer.split(' ').slice(-1)[0];
                if (!name)
                    name = buffer.split(' ').slice(-2)[0]+' ';

                for (var i=0; i<name.length; i++)
                    this.terminal.backspace();
                break;
            case termKey.TAB: // TAB
                var buffer = this.terminal._getLine();
                var pwd = this.user.pwd;
                var append = false;

                // last element split by '/' (for multiple dirs)
                var tmp = buffer.split(' ').slice(-1)[0];
                var names = tmp.split('/');
                var name = names.pop();

                if (tmp.substring(0,1) == '/')
                    pwd = names.join('/')+'/';
                else if (names.length)
                    pwd += names.join('/')+'/';

                cmds = this.fs.command(name, pwd, true); //search

                if (cmds.length == 0) {
                    // should show full dir list here...
                    append = buffer;
                } else if (cmds.length == 1) {
                    show_prompt = false;
                    var end = (cmds[0].type == 'dir') ? '/' : ' ';
                    var rest = cmds[0].name.substring(name.length)+end;
                    this.terminal.type(rest);
                } else {
                    var output = '';
                    for (var i=0; i<cmds.length; i++)
                        output += cmds[i].name+" ";

                    this.write('%n');
                    this.write(output);
                    append = buffer;
                    show_prompt = true;
                }
                break;
            default:
                this._command(input);
                break;
        }

        if (!this.user.sudoInput) {
            if (show_prompt)
                this.prompt();
            if (append) {
                this.terminal.type(append);
                append = false;
            }
        }
    },

    write: function(output) { this.terminal.write(output); },
    prompt: function() {
        this.terminal.ps = this._prompt();
        this.terminal.prompt();
    },

    mkdir: function(name, path) {
        var inode = this.fs._name_in_path(name, path);
        if (!inode) {
            var new_inode = new Inode({
                'name': name,
                'type': 'dir',
                'path': path,
                'access': function(kernel, argv) {
                    return { 'output': '' } // normal operation
                }
            });
            var i = this.fs.add_inode(new_inode);
        } else if (inode.type != "dir") {
            throw {'output': 'File exists.'}
        } else if (inode.type == "dir") {
            throw {'output': 'Directory exists.'}
        }
        return true;
    },

    touch: function(name, path) {
        var inode = this.fs._name_in_path(name, path);
        if (!inode) {
            var new_inode = new Inode({
                'name': name,
                'type': 'file',
                'path': path,
                'access': function(kernel, argv) {
                    return { 'output': '' }
                }
            });
            var i = this.fs.add_inode(new_inode);
        } else {
            throw {'output': 'File exists.'};
        }
    },

    cd: function(name, path) {
        var inode = this.fs._name_in_path(name, path);
        if (inode) { // path exists
            if (inode.type != 'dir')
                throw {'output': 'Not a directory.'};

            this.user.pwd = path+name+'/';

            res = inode.access(this);
            switch(res.action) {
                case 'redirect':
                    window.open(res.value, '', '');
                    break;
                default:
                    break;
            }
        } else
            throw {'output': 'No such directory.'};
    },

    //private:
    _command: function(argv) {
        if (!argv[0]) return; // \n

        // get cmd from fs
        var i = this.fs.command(argv[0], this.user.pwd);

        // sudo exception
        if (this.user.sudoInput) {
            // sudoInput is set, override to sudo command
            i = this.fs.command("sudo");
        }

        if (!i)
            this.terminal.write(argv[0]+": command not found.");
        else {
            var res = i.access(this, argv);
            var output = (res) ? res.output : '';
            var action = (res) ? res.action : '';
            this.terminal.write(output);
            // more
        }
        return;
    },

    //private:
    _prompt: function() {
        var pwd = this.user.pwd;
        if (pwd == this.user.homedir)
            pwd = '~';

        return [
            this.user.name,
            "@",
            this.name,
            ":",
            pwd,
            this.user.prompt,
        ].join('');
    },

    _authorization: function() {
        return true;
    },

    _blank: false
}

var User = function(kwargs) {
    kwargs = (!kwargs) ? {} : kwargs

    this.id = this.random_id();
    this.name = "guest";
    this.sudo = false;
    this.sudoInput = false;
    this.pwd = "/";

    this.user_prompt = kwargs.user_prompt ? kwargs.user_prompt : ">";
    this.root_prompt = kwargs.root_prompt ? kwargs.root_prompt : "#";
    this.prompt = (this.id==0) ? this.root_prompt : this.user_prompt;

}; User.prototype = {
    //public:
    is_root: function() {
        return this.id == 0 ? true : false;
    },

    root: function(bool) {
        if (bool) {
            this.name = "root";
            this.id = 0;
            this.prompt = this.root_prompt;
        } else {
            this.name = "guest";
            this.id = this.random_id();
            this.prompt = this.user_prompt;
        }
    },

    // private:
    random_id: function() {
        return Math.floor(Math.random()*9000) + 1000;
    }
}

// Filesystem
var Filesystem = function(kwargs) {
    kwargs = (!kwargs) ? {} : kwargs

    this.PATH = ['/', '/bin/'];
    this.inodes = {}; //<guid>: <object>
    this.dirs = {};

}; Filesystem.prototype = {

    command: function(cmd, pwd, search) {
        search = (search) ? true : false;
        var _path = this.PATH;
        var results = [];

        if (_path.indexOf(pwd) == -1) {
            _path.push(this.PATH.push(pwd)); // push current into path
        }

        if (search && !cmd) return [];

        for (var j=0; j < _path.length; j++) {
            var path = _path[j];
            var inodes = this._inodes_for_path(path);
            for (var k=0; k < inodes.length; k++) {
                var inode = inodes[k];
                var obj = this.inodes[inode];

                if (search) {
                    if (obj.name.lastIndexOf(cmd, 0) == 0) {
                        results.push(obj);
                    }
                }
                else if (obj.name == cmd && obj.type == "cmd") {
                    return obj
                }
            }
        }
        return (search) ? results : undefined;
    },

    add_inodes: function(inodes) {
        for (var i=0; i<inodes.length; i++)
            this.add_inode(inodes[i]);
    },

    add_inode: function(inode) {
        var dir = this.dirs[inode.path];
        if (dir == undefined) {
            this.dirs[inode.path] = {'inodes': []};
        }
        var dir = this.dirs[inode.path];

        guid = this._guid();
        this.inodes[guid] = inode;
        this.dirs[inode.path].inodes.push(guid);
        return guid;
    },

    map_inodes_in_path: function(func, path) {
        var results = [];
        // run function for every object
        var inodes = this._inodes_for_path(path);
        for (var k=0; k < inodes.length; k++) {
            // hidden files / perms here later?
            var obj = this.inodes[inodes[k]];
            results.push(func(obj));
        }
        return results;
    },

    iterate_paths: function(pwd, dirs) {
        paths = [];
        if (dirs.substring(0,1) == '/')
            // string leading / for split purposes
            dirs = dirs.substring(1);
        dirs = dirs.split('/');

        for (var k=0; k < dirs.length; k++) {
            var name = dirs[k];

            var fullpath = pwd+dirs.slice(0,k).join('/');
            if (k != 0)
                fullpath += '/'; // add / when its not the root

            if (name)
                paths.push({'name': name, 'fullpath': fullpath});
        }
        return paths;
    },

    path_exists: function(path) {
        return (this.dirs[path] != undefined);
    },

    // private:

    _name_in_path: function(name, path) {
        // return the inode object for name in path
        var func = function(inode) {
            if (inode.name == name)
                return inode;
            return false;
        };

        // results : Array containing results from name comparison
        //           ... not optimal, I know.
        var results = this.map_inodes_in_path(func, path);

        for (var k=0; k < results.length; k++) {
            // return the inode id
            if (results[k]) return results[k];
        }
        return false;
    },

    _inodes_for_path: function(path) {
        var d = this.dirs[path];
        return (d) ? d.inodes : [];
    },

    _sanitize_path: function(path) {
        if (path.substring(0, 1) == "/")
            return path;
        return '/'+path;
    },

    _guid: function() {
        // passes snuff (from stackoverflow)
        var S4 = function () {
            return Math.floor(Math.random() * 0x10000).toString(16);
        };
        return (S4()+S4()+"-"+S4()+"-"+S4()+"-"+S4()+"-"+S4()+S4()+S4());
    }
}

// Inode Base
var Inode = function(obj) {

    this.name = obj.name; // required
    this.type = obj.type; //required
    this.path = (obj.path) ? obj.path : '/'; //required
    this.su = (obj.su) ? obj.su : false; // optional
    this.access = (obj.access) ? obj.access : this._access;

}; Inode.prototype = {
    // public:

    //// override access
    _access: function(kernel, argv) {
        args = argv.slice(1);

        return {
            'output': argv[0]+": command not found.",
            'msg': null
        }
    },

    ls_format: function(kernel, detail) {
        var name = this.name;
        var perm = "-rwx------";

        var user = "root";
        var user_length = 10;

        var size = "14";
        var size_length = 5;

        if (kernel.user.pwd.indexOf(kernel.user.homedir) != -1)
            user = kernel.user.name; // in users homedir

        console.log("type: "+this.type);

        switch (this.type) {
            case 'dir':
                perm = "d"+perm.substr(1,perm.length);
                name += "/ ";
                break;
            case "cmd":
                name += "* ";
                size = "109";
                break;
            case "file":
                perm = perm.substr(0,3)+"-"+perm.substr(4,perm.length);
                perm[3] = "-";
                size = "50";
                break;
            default:
                break;
        }

        for (var x=0; x<user_length; x++)
            user[x] = (user[x]) ? user[x] : " ";
        for (var x=0; x<size_length; x++)
            size[x] = (size[x]) ? size[x] : " ";

        if (detail)
            return perm+" "+user+" "+size+" "+name;
        return name;
    },

    _blank: true
}

// var cmds

var help = new Inode({'name': 'help', 'type': 'cmd', 'path': '/bin/',
    'access': function() {
        return {'output': [
            '****************************************',
            '* ipsh tries to implement most unix cmds',
            '* so feel free to poke around the system',
            '****************************************',
            '',
        ]}
    }
});

var bash = new Inode({
    'name': 'bash',
    'type': 'cmd',
    'path': '/bin/',
    'access': function(kernel, argv) {
        if (kernel.user.sudo)
            kernel.user.root(true);
    }
});

var df = new Inode({'name': 'df', 'type': 'cmd', 'path': '/bin/',
    'access': function(kernel, argv) {
        var output = [
            'Filesystem  1K-blocks     Used  Available  Use%%  Mounted on',
            '/dev/xvda    10452384  6786764    3141284   69%%  /',
            'udev           498356        4     498352    1%%  /dev',
            'tmpfs          203060      212     202848    1%%  /run',
            'none             5120        0       5120    0%%  /run/lock',
            'none           507644        0     507644    0%%  /run/shm'
        ];

        if (argv[1]) {
            if (argv[1].substring(0,1) == '-') {
                if (argv[1].slice(1).indexOf('h') != -1) {
                    output = [
                        'Filesystem      Size   Used  Avail Capacity  iused    ifree %%iused  Mounted on',
                        '/dev/xvda      233Gi  112Gi  120Gi    49%% 29540479 31528961   48%%   /',
                        'devfs          183Ki  183Ki    0Bi   100%%      634        0  100%%   /dev',
                        'map -hosts       0Bi    0Bi    0Bi   100%%        0        0  100%%   /net',
                        'map auto_home    0Bi    0Bi    0Bi   100%%        0        0  100%%   /home'
                    ];
                }
            }
        }
        return {'output': output};
    }
});

var id = new Inode({
    'name': 'id',
    'type': 'cmd',
    'path': '/bin/',
    'access': function(kernel, argv) {
        var output = 'id='+kernel.user.id;
        if (kernel.user.is_root())
            output += '(root)';
        else
            output += '(gest)';
        return {'output': output}
    }
});

var make = new Inode({
    'name': 'make',
    'type': 'cmd',
    'path': '/bin/',
    'access': function(kernel, argv) {
        var output = 'I don\'t listen to you.';

        if (kernel.user.sudo)
            output = 'Anything for you.';

        return {'output': output};
    }
});

var sudo = new Inode({
    'name': 'sudo',
    'type': 'cmd',
    'path': '/bin/',
    'access': function(kernel, argv) {
        kernel.user.sudo = kernel.user.is_root() ? true : false;
        var sudo_argv = kernel.user.sudoInput;

        if (sudo_argv) {
            kernel.terminal.rawMode = false;
            kernel.terminal.lock = false;

            if (argv[0] != 'sudo') {
                if (argv[0] != 'jarrod') {
                    kernel.user.sudoInput = false;
                    return {'output': 'Incorrect password.'}
                }
            }

            kernel.user.sudo = true;
        } else {
            if (!kernel.user.sudo) {
                kernel.user.sudoInput = argv;
                kernel.terminal.rawMode = true;
                kernel.terminal.lock = false;
                return {'output': 'Password: '};
            }
            sudo_argv = argv; // in case you're root
        }

        // access the command (root || success)
        kernel.user.sudoInput = false;
        return kernel.input(sudo_argv.slice(1));
    }
});

var ls = new Inode({
    'name': 'ls',
    'type': 'cmd',
    'path': '/bin/',
    'su': 'false',
    'access': function(kernel, argv) {
        var output = [];
        var detail = false;
        var pwd = kernel.user.pwd;

        var func = function(inode) {
            output.push(inode.ls_format(kernel, detail));
        }

        if (argv[1]) {
            if (argv[1].substring(0,1) == '-') {
                // detail true for all arguments for now
                detail = true;
                argv = [argv[0]].concat(argv.slice(2));
            }
        }

        try {
            if (!argv[1])
                kernel.fs.map_inodes_in_path(func, pwd);
            else {
                var obj = kernel.fs.iterate_paths(pwd, argv[1]).slice(-1)[0];

                var testpath = obj.fullpath+obj.name+'/';
                if (kernel.fs.path_exists(testpath))
                    kernel.fs.map_inodes_in_path(func, testpath);
                else if (kernel.fs._name_in_path(obj.name, obj.fullpath))
                    output.push(obj.name);
                else
                    output.push('');
            }
        } catch(err) {
            return err;
        }

        return {'output': output}
    }
});

var rm = new Inode({'name': 'rm', 'type': 'cmd', 'path': '/bin/',
    'access': function(kernel, argv) {
        if (argv.length == 1)
            return {'output': 'rm [options] <file>'};
        return {'output': 'nope.'};
    }
});

var echo = new Inode({'name': 'echo', 'type': 'cmd', 'path': '/bin/',
    'access': function(kernel, argv) {
        if (argv.length == 1)
            return {'output': ' '};

        if (argv[1].substring(0,1) == '$') {
            switch(argv[1].slice(1)) {
                case 'shell':
                case 'SHELL':
                    return {'output': '/bin/bash'};
                    break;
                case 'path':
                case 'PATH':
                    return {'output': "["+kernel.fs.PATH.join(",")+"]"};
                    break;
                default:
                    return {'output': ' '}
            }
        } else if (argv[1].substring(0,1) == '"') {
            var output = argv[1].slice(1);
            if (output.slice(-1)[0] != '"') {
                // spans arguments
                // does not take into account "string">>file.txt
                for (var k=2; k<=argv.slice(1).length; k++) {
                    if (argv[k].slice(-1)[0] != '"') {
                        // look for closing double quote "
                        output += ' '+argv[k];
                    } else {
                        output += ' '+argv[k].slice(0, argv[k].length-1);
                        break;
                    }
                }
            } else {
                output = output.slice(0, output.length-1);
            }
            return {'output': output};
        }

        return {'output': argv.slice(1)};
    }
});

var mkdir = new Inode({
    'name': 'mkdir',
    'type': 'cmd',
    'path': '/bin/',
    'su': true,
    'access': function(kernel, argv) {
        var usage = argv[0]+' <dir>';
        var pwd = kernel.user.pwd;
        var detail = false;

        // only one file at a time until i add a loop
        if (argv.length != 2 )
            return {'output': usage}

        try {
            paths = kernel.fs.iterate_paths(pwd, argv[1]);
            for (var i in paths) {
                obj = paths[i];

                var objpath = obj.fullpath+obj.name+'/';
                if (!kernel.fs.path_exists(objpath)) {
                    // buggy
                    kernel.mkdir(obj.name, obj.fullpath);
                }
            }
        } catch(err) {
            console.log(err);
            return err;
        }
        return {'output': ''};
    }
});

var touch = new Inode({
    'name': 'touch',
    'type': 'cmd',
    'path': '/bin/',
    'access': function(kernel, argv) {
        var usage = argv[0]+' <file>';
        var pwd = kernel.user.pwd;

        // only one file at a time until i add a loop
        if (argv.length != 2)
            return {'output': usage}

        // add sanity
        try {
            // touch just looks to create in the last path
            var obj = kernel.fs.iterate_paths(pwd, argv[1]).slice(-1)[0];
            if (kernel.fs.path_exists(obj.fullpath)) {
                kernel.touch(obj.name, obj.fullpath);
            } else
                return {'output': 'No such file or directory.'};
        } catch(err) {
            return err;
        }
        return {'output': ''}
    }
});

var cat = new Inode({
    'name':'cat',
    'type':'cmd',
    'path':'/bin/',
    'access': function(kernel, argv) {
        var usage = argv[0]+' <file>';
        var pwd = kernel.user.pwd;

        if (argv.length != 2)
            return {'output': usage};

        try {
            var obj = kernel.fs.iterate_paths(pwd, argv[1]).slice(-1)[0];
            var inode = kernel.fs._name_in_path(obj.name, obj.fullpath)
            if (inode.type == "file")
                return inode.access(kernel);
            else
                return {'output': argv[1]+": Not a file."}
        } catch(err) {
            return {'output': err};
        }
    }
});

var cd = new Inode({
    'name': 'cd',
    'type': 'cmd',
    'path': '/bin/',
    'access': function(kernel, argv) {
        var dir = argv[1];
        var pwd = kernel.user.pwd;

        if (argv.length != 2) {
            kernel.user.pwd = kernel.user.homedir;
            return {'output': ''};
        }

        if (dir == "~" || dir == "~/") {
            kernel.user.pwd = kernel.user.homedir;
            return;
        } else if (dir == "/") {
            kernel.user.pwd = '/';
            return;
        } else if (dir == ".." || dir == "../") {
            if (!(kernel.user.pwd == '/')) {
                var dirs = kernel.user.pwd.split('/');
                if (dirs.length == 1 )
                    kernel.user.pwd = '/';
                else {
                    dirs.pop();
                    dirs.pop();
                    kernel.user.pwd = dirs.join('/')+'/';
                }
            }
            return;
        } else if (dir == "." || dir == "./")
            return {'output':''};

        try {
            if (argv[1].substring(0,1) == '/')
                pwd = '/';

            var obj = kernel.fs.iterate_paths(pwd, argv[1]).slice(-1)[0];
            kernel.cd(obj.name, obj.fullpath);
        } catch(err) {
            return err;
        }
        return {'output': ''}
    }
});

var pwd = new Inode({
    'name': 'pwd',
    'type': 'cmd',
    'path': '/bin/',
    'access': function(kernel, argv) {
        return {'output': kernel.user.pwd}
    }
});

var vim = new Inode({'name': 'vim', 'type': 'cmd', 'path': '/bin/',
    'access': function(kernel, argv) {
        return {'output': 'Not yet.'}
    }
});

var exit = new Inode({'name': 'exit', 'type': 'cmd', 'path': '/bin/',
    'access': function(kernel, argv) {
        if (kernel.user.is_root())
            kernel.user.root(false);
        else
            kernel.terminal.close();
    }
});

//easter
var amber = new Inode({'name':'amber', 'type':'cmd', 'path':'/bin/',
    'access': function(kernel, argv) {
        return {'output': 'The love of my life.'}
    }
});

// files
// get these out of here!

var root_README = new Inode({'name':'README', 'type':'file', 'path':'/root/',
    'access': function(kernel, argv) {
        return {
            'output': [
                '******* TOP SECRET ********',
                ''
            ],
        }
    }
});

// dirs
var work = new Inode({'name': 'work', 'type': 'dir', 'path': '/home/guest/',
    'access': function(kernel, argv) {
        return {
            'output': '*** Redirecting to ipglobal.net ***',
            'action': 'redirect',
            'value': 'http://ipglobal.net'
        }
    }
});

var code = new Inode({'name':'code', 'type':'dir', 'path': '/home/guest/',
    'access': function() {
        return {
            'output': '*** Redirecting to github.com ***',
            'action': 'redirect',
            'value': 'http://github.com/jarrodb'
        }
    }
});

//

var aboutme = new Inode({'name':'about.txt', 'type':'file',
    'path': '/home/guest/',
    'access': function(kernel, argv) {
        return {
            'output': [
                '**** About Me ****',
                '',
                'Name : Jarrod Baumann',
                'Web  : http://j.arrod.org',
                'Email: j@rrod.org',
                ''
            ],
        }
    }
});
