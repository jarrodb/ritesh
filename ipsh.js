
/// Objects

var Host = function(terminal, kwargs) {
    kwargs = (!kwargs) ? {} : kwargs

    if (!terminal)
        return {'error': 'termlib.js Terminal required'}

    //
    this.name = kwargs.name ? kwargs.name : 'ipgn'; // hostname
    this.kernel = new Kernel(terminal, {});

    this.motd = [
        '******* MOTD ********',
        ' '
    ];

    // ghettoness insues
    this.kernel.fs.add_inode(ls); //ghetto
    this.kernel.fs.add_inode(cd); //ghetto
    this.kernel.fs.add_inode(cat); //ghetto
    this.kernel.fs.add_inode(exit); //ghetto
    this.kernel.fs.add_inode(make); //ghetto
    this.kernel.fs.add_inode(sudo); //ghetto
    this.kernel.fs.add_inode(mkdir); //ghetto
    this.kernel.fs.add_inode(touch); //ghetto
    this.kernel.fs.add_inode(aboutme); //ghetto
    this.kernel.fs.add_inode(root_README); //ghetto
    this.kernel.fs.add_inode(root); //ghetto
    this.kernel.fs.add_inode(work); //ghetto
    this.kernel.fs.add_inode(code); //ghetto
    this.kernel.fs.add_inode(bash); //ghetto
    this.kernel.fs.add_inode(id); //ghetto

}; Host.prototype = {
    //public:
    inputHandler: function(input, ctrl) {
        this.kernel.input(input, ctrl);
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


}; Kernel.prototype = {
    //public:
    input: function(input, ctrl) {
        var show_prompt = true;
        var append = false;

        switch(this.terminal.inputChar) {
            case termKey.ETX:
                //this.terminal.close(); // ^C
                break;
            case termKey.NAK:
                show_prompt = false;
                this.terminal._clearLine();
                break;
            case termKey.EOT:
                this._command('exit');
                break;
            case termKey.TAB:
                var buffer = this.terminal._getLine();
                var name = buffer.split(' ').slice(-1)[0]; // last element

                cmds = this.fs.command(name, true); // search=true
                if (cmds.length == 1) {
                    show_prompt = false;
                    var rest = cmds[0].substring(name.length)+' ';
                    this.terminal.type(rest);
                } else {
                    this.write('%n');
                    this.write(cmds.join('%n'));
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
        var i = this.fs.command(argv[0]);

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
        return [
            this.user.name,
            "@",
            this.name,
            ":",
            this.user.pwd,
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

    this.PATH = ['/', '/usr/bin'];
    this.inodes = {}; //<guid>: <object>
    this.dirs = {};

}; Filesystem.prototype = {

    command: function(cmd, search) {
        search = (search) ? true : false;
        var path = this.PATH;
        var results = [];

        //if (path.indexOf(pwd) == -1)
        //    path.push(this.PATH.push(pwd)); // "."

        if (search && !cmd) return [];

        for (var j=0; j < this.PATH.length; j++) {
            var path = this.PATH[j];
            var inodes = this._inodes_for_path(path);
            for (var k=0; k < inodes.length; k++) {
                var inode = inodes[k];
                var obj = this.inodes[inode];

                if (search) {
                    if (obj.name.lastIndexOf(cmd, 0) == 0) {
                        results.push(obj.name);
                    }
                }
                else if (obj.name == cmd && obj.type == "cmd") {
                    return obj
                }
            }
        }
        return (search) ? results : undefined;
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

    ls_format: function() {
        if (this.type == "dir")
            return this.name+"/ ";
        else if (this.type == "cmd")
            return this.name+"* ";
        else
            return this.name;
    },

    _blank: true
}

// var cmds

var bash = new Inode({
    'name': 'bash',
    'type': 'cmd',
    'path': '/usr/bin',
    'access': function(kernel, argv) {
        if (kernel.user.sudo)
            kernel.user.root(true);
    }
});

var id = new Inode({
    'name': 'id',
    'type': 'cmd',
    'path': '/usr/bin',
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
    'path': '/usr/bin',
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
    'path': '/usr/bin',
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
    'path': '/usr/bin',
    'su': 'false',
    'access': function(kernel, argv) {
        var output = [];
        var detail = false;

        var func = function(inode) {
            output.push(inode.ls_format());
        }

        kernel.fs.map_inodes_in_path(func, kernel.user.pwd);

        return {'output': output}
    }
});


var mkdir = new Inode({
    'name': 'mkdir',
    'type': 'cmd',
    'path': '/usr/bin',
    'su': true,
    'access': function(kernel, argv) {
        var usage = argv[0]+' <dir>';
        var pwd = kernel.user.pwd;

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
    'path': '/usr/bin',
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
    'path':'/usr/bin',
    'access': function(kernel, argv) {
        var filename = argv[1];

        var inodes = kernel.fs._inodes_for_path(kernel.user.pwd);
        for (var k=0; k < inodes.length; k++) {
            var obj = kernel.fs.inodes[inodes[k]];
            if (obj.name == filename) {
                if (obj.type == "file") {
                    return obj.access(kernel);
                } else {
                    return {'output': argv[1]+": Not a file."}
            }
            }
        }
        return {'output': argv[1]+": No such file or directory."}
    }
});

var cd = new Inode({
    'name': 'cd',
    'type': 'cmd',
    'path': '/usr/bin',
    'access': function(kernel, argv) {
        var dir = argv[1];
        var pwd = kernel.user.pwd;

        if (argv.length != 2)
            return {'output': 'cd <directory>'}

        if (dir == "..") {
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
        }

        try {
            if (argv[1].substring(0,1) == '/')
                pwd = '/';

            var obj = kernel.fs.iterate_paths(pwd, argv[1]).slice(-1)[0];
            console.log(obj);
            kernel.cd(obj.name, obj.fullpath);
        } catch(err) {
            return err;
        }
        return {'output': ''}
    }
});

var exit = new Inode({
    'name': 'exit',
    'type': 'cmd',
    'path': '/usr/bin',
    'access': function(kernel, argv) {
        if (kernel.user.is_root())
            kernel.user.root(false);
        else
            kernel.terminal.close();
    }
});

// files
// get these out of here!
var aboutme = new Inode({
    'name':'about.txt',
    'type':'file',
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

var root_README = new Inode({
    'name':'README',
    'type':'file',
    'path':'/root/',
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
var work = new Inode({
    'name':'work',
    'type':'dir',
    'access': function(kernel, argv) {
        return {
            'output': '*** Redirecting to ipglobal.net ***',
            'action': 'redirect',
            'value': 'http://ipglobal.net'
        }
    }
});

var code = new Inode({
    'name':'code',
    'type':'dir',
    'access': function(kernel, argv) {
        return {
            'output': '*** Redirecting to github.com ***',
            'action': 'redirect',
            'value': 'http://github.com/jarrodb'
        }
    }
});

var root = new Inode({
    'name':'root',
    'type':'dir',
    'access': function(kernel, argv) {
        return { 'output': '' } // normal operation
    }
});
