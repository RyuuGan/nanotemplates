"use strict";

var path = require('path')
  , fs = require('fs')
  , async = require('async')
  , AngularExpressions = require('angular-expressions')
  , Parser = require('./parser');

var runtime = fs.readFileSync(path.join(__dirname, 'runtime.js'), 'utf-8');

var Compiler = module.exports = exports = function(options) {

  this.basedir = options.basedir || process.cwd();

  this.load = typeof options.load == 'function' ?
    options.load : require('./loader').FileLoader(this.basedir);

};

Compiler.prototype.compile = function(file, done) {
  new Job(this, file).compile(done);
};

var Job = exports.Job = function(compiler, file) {
  this.compiler = compiler;
  this.file = file;
  this.expressions = [];
  this.cachedNodes = {};
};

Job.prototype.load = function(file, done) {
  return this.compiler.load(file, done);
};

Job.prototype.compile = function(done) {
  var job = this;
  job._processFile(job.file, {
    file: job.file,
    defs: {}
  }, function(err, code) {
    if (err) return done(err);
    var fn = new Function('context', runtime +
        'return function(locals) {' +
        'locals = locals || {};' +
        code +
        ';return out.join("");' +
        '}'
    );
    done(null, fn({
      expressions: job.expressions
    }));
  });
};

Job.prototype._processFile = function(file, ctx, done) {
  var job = this;
  var parentFile = ctx.parent && ctx.parent.file;
  file = localPath(parentFile || '', file);
  // Check cache for parsed AST
  var cached = job.cachedNodes[file];
  if (cached)
    return job._processNodes(cached, ctx, done);
  // Load and parse template
  job.load(file, function(err, content) {
    if (err) return done(err);
    try {
      var nodes = Parser.parse(content);
      job.cachedNodes[file] = nodes;
      job._processNodes(nodes, ctx, done);
    } catch (e) {
      done(e);
    }
  });
};

Job.prototype._processNodes = function(nodes, ctx, done) {
  var job = this;
  async.mapSeries(nodes, function(node, cb) {
    if (typeof node == 'string')
      return job._process_plain(node, cb);
    return job['_process_' + node.type](node, ctx, cb);
  }, function(err, statements) {
    if (err) return done(err);
    done(null, statements.join(';'));
  });
};

Job.prototype._process_plain = function(text, done) {
  done(null, 'out.push(' + escapeJsString(text) + ')');
};

Job.prototype._process_def = function(node, ctx, done) {
  var job = this;
  job._processNodes(node.nodes, ctx, function(err, code) {
    if (err) return done(err);
    ctx.defs[node.name] = {
      mode: node.mode,
      code: code
    };
    done(null, []);
  });
};

Job.prototype._process_block = function(node, ctx, done) {
  var job = this;
  var def = findDefinition(node.name, ctx);
  job._processNodes(node.nodes, ctx, function(err, code) {
    if (err) return done(err);
    if (!def)
      return done(null, code);
    switch (def.mode) {
      case 'append':
        return done(null, [code, def.code].join(';'));
      case 'prepend':
        return done(null, [def.code].join(';'));
      default:
        return done(null, def.code);
    }
  });
};

Job.prototype._process_include = function(node, ctx, done) {
  ctx = {
    parent: ctx,
    file: localPath(ctx.file, node.file),
    defs: {}
  };
  var job = this;
  async.mapSeries(node.nodes, function(node, cb) {
    return job['_process_' + node.type](node, ctx, cb);
  }, function(err, statements) {
    if (err) return done(err);
    // Read included file
    job._processFile(node.file, ctx, function(err, code) {
      if (err) return done(err);
      // Join all statements
      code = statements.concat([code]).join(';');
      // Wrap statements into scoped context
      done(null, scoped(code));
    });
  });
};

Job.prototype._process_expr = function(node, ctx, done) {
  var job = this;
  try {
    job.expressions.push(AngularExpressions.compile(node.expr));
    var index = job.expressions.length - 1;
    var st = null;
    if (node.buffer) {
      if (node.escape) {
        st = 'out.push(escapeHtml($$[' + index + '](locals)))';
      } else {
        st = 'out.push($$[' + index + '](locals))';
      }
    } else {
      st = '$$[' + index + '](locals)';
    }
    done(null, st);
  } catch (e) {
    return done(e)
  }
};

Job.prototype._process_var = function(node, ctx, done) {
  var job = this;
  try {
    job.expressions.push(AngularExpressions.compile(node.expr));
    var index = job.expressions.length - 1;
    done(null, 'locals.' + node.name + ' = $$[' + index + '](locals)');
  } catch (e) {
    return done(e)
  }
};

function localPath(relativeTo, file) {
  file = path.normalize(file);
  if (file.indexOf('/') == 0)
    return file.replace(/^\/+/, '');
  return path.normalize(path.join(path.dirname(relativeTo), file))
    .replace(/^\.{0,2}\/+/, '');
}

function findDefinition(name, ctx) {
  var def = ctx.defs[name];
  if (def)
    return def;
  return ctx.parent ? findDefinition(name, ctx.parent) : null;
}

function escapeJsString(str) {
  return JSON.stringify(str);
}

function scoped(code) {
  return '(function(locals){' + code + '})(Object.create(locals))'
}