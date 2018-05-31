var semver = require('semver'),
    path = require('path'),
    through = require('through2'),
    fs = require('vinyl-fs'),
    fUtil = require('./lib/files'),
    git = require('./lib/git');

const assemblyInfoVerRegex = /(?:\n\[assembly\: AssemblyVersion\(")([^"]+)(?:"\)\])/,
      assemblyInfoVerInverseRegex = /(\n\[assembly\: AssemblyVersion\(")(?:[^"]+)("\)\])/,
      assemblyFileInfoVerInverseRegex = /(\n\[assembly\: AssemblyFileVersion\(")(?:[^"]+)("\)\])/,
      assemblyInformationalVerInverseRegex = /(\n\[assembly\: AssemblyInformationalVersion\(")(?:[^"]+)("\)\])/;

exports.get = function (callback) {
  var result = fUtil.loadFiles();
  var ret = {};
  var errors = [];

  return result
    .on('data', function (file) {
      try {
        switch (path.extname(file.path)) {
          case '.json': {
            var contents = JSON.parse(file.contents.toString());
            ret[path.basename(file.path)] = contents.version;
          }
          break;

          case '.cs': {
            var contents = file.contents.toString();
            
            if (!assemblyInfoVerRegex.test(contents)) {
              throw new Error('This is possibly not an AssemblyInfo.cs file.');
            }

            ret[path.basename(file.path)] = contents.match(assemblyInfoVerRegex)[1];
          }
          break;

          default:
            throw new Error(`Extension '${file.extname}' isn't supported.`);
        }
      } catch (e) {
        errors.push(file.relative + ": " + e.message);
      }
    })
    .on('end', function () {
      if (errors.length) {
        return callback(new Error(errors.join('\n')), ret);
      }
      return callback(null, ret);
    });
};

exports.isPackageFile = fUtil.isPackageFile;

var versionAliases = exports.versionAliases = {
  "pa": "patch",
  "pr": "prerelease",
  "ma": "major",
  "mi": "minor",
  // one char might be controversial, but it saves key strokes
  "m": "major",
  "p": "patch",
  "i": "minor"
};

var updateJSON = exports.updateJSON = function (obj, ver) {
  ver = ver.toString().toLowerCase();

  // check for aliases
  if(ver in versionAliases){
    ver = versionAliases[ver];
  }

  var validVer = semver.valid(ver);
  obj = obj || {};
  var currentVer = obj.version;

  if (validVer === null) {
    validVer = semver.inc(currentVer, ver);
  }

  if (validVer === null) {
    return false;
  }

  obj.version = validVer;
  return validVer;
};

var getNewVer_AssemblyInfoCs = exports.getNewVer_AssemblyInfoCs = function (contents, ver) {
  ver = ver.toString().toLowerCase();

  // check for aliases
  if(ver in versionAliases){
    ver = versionAliases[ver];
  }

  var validVer = semver.valid(ver);
  var currentVer = contents.match(assemblyInfoVerRegex)[1];

  if (validVer === null) {
    validVer = semver.inc(currentVer, ver);
  }

  if (validVer === null) {
    return false;
  }

  return validVer;
}

exports.update = function (options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }

  options = options || {};

  if (typeof options === "string") {
    options = {
      version: options,
      noPrefix: false,
      precommit: void 0,
      commitMessage: void 0
    };
  }

  if (!options.tagName) {
    options.tagName = (options.noPrefix ? '' : 'v') + '%s';
  }

  var ver = options.version || 'minor';
  var noPrefix = !!options.noPrefix;
  var commitMessage = options.commitMessage || void 0;
  var precommitCallback = options.precommit;
  callback = callback || noop();

  (function (done) {
    if (commitMessage) {
      return git.isRepositoryClean(done);
    }
    return done(null);
  })(function(err) {
    if (err) {
      callback(err);
      return void 0;
    }

    var files = [],
        errors = [],
        fileStream = fUtil.loadFiles(),
        versionList = {},
        newVer = null;

    var stored = fileStream.pipe(through.obj(function(file, e, next) {
      if (file == null || file.isNull()) {
        this.push(null);
        next();
        return;
      }
      var contents = file.contents.toString(),
          newVersionGetter, newFileContentsGetter;

      switch (path.extname(file.path)) {
        case '.json': {
          try {
            var json = JSON.parse(contents);
            newVersionGetter = () => updateJSON(json, ver);
            newFileContentsGetter = () => new Buffer(JSON.stringify(json, null, fUtil.space(contents)) + fUtil.getLastChar(contents));
          } catch (e) {
            errors.push(new Error(file.relative + ': ' + e.message));
            next();
            return;
          }
        }
        break;

        case '.cs': {
          newVersionGetter = () => getNewVer_AssemblyInfoCs(contents, ver);
          newFileContentsGetter = () => new Buffer(contents
            .replace(assemblyInfoVerInverseRegex, function (match, part1, part2) { return `${part1}${newVer}${part2}`; })
            .replace(assemblyFileInfoVerInverseRegex, function (match, part1, part2) { return `${part1}${newVer}${part2}`; })
            .replace(assemblyInformationalVerInverseRegex, function (match, part1, part2) { return `${part1}${newVer}${part2}`; }));
        }
        break;

        default: {
          errors.push(new Error(file.relative + ': ' + `Extension '${file.extname}' isn't supported.`));
          next();
          return;
        }
        break;
      }

      newVer = newVersionGetter();

      if (newVer === false) {
        this.emit('error', new Error('Version bump failed, ' + ver + ' is not valid version.'))
        return void 0;
      }

      file.contents = newFileContentsGetter();
      versionList[path.basename(file.path)] = newVer;

      this.push(file);
      next();
    }))
    .on('error', function (err) {
      callback(err);
    })
    .pipe(fs.dest(function (file) {
      return path.dirname(file.path);
    }));

    stored.on('data', function (file) {
      files.push(file.path);
    });

    stored.on('end', function () {
      var errorMessage = null;
      if (errors.length) {
        errorMessage = errors.map(function (e) {
          return " * " + e.message;
        }).join('\n');
      }

      newVer = newVer || 'N/A';

      var ret = {
        newVersion: newVer,
        versions: versionList,
        message: files.map(function (file) {
          return 'Updated ' + path.basename(file);
        }).join('\n'),
        updatedFiles: files
      };

      if (!commitMessage || errorMessage) {
        callback(errorMessage ? new Error(errorMessage) : null, ret);
        return void 0;
      }

      if (!precommitCallback) {
        return doCommit();
      }

      precommitCallback(function (err) {
        if (err) {
          return git.checkout();
        }
        doCommit();
      });

      function doCommit () {
        var tagName = options.tagName.replace('%s', newVer).replace('"', '').replace("'", '');
        git.commit(files, commitMessage, newVer, tagName, function (err) {
          if (err) {
            callback(err, null);
            return void 0;
          }

          ret.message += '\nCommited to git and created tag ' + tagName;
          callback(null, ret);
        });
      }
    });
  });
  return this;
};



function noop () {
  return function () { };
}
