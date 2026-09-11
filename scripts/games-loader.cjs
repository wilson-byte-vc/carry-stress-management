const swc = require('../website_codeconnection/node_modules/next/dist/build/swc');
module.exports = function (source) {
  const done = this.async();
  swc.loadBindings().then(() => swc.transform(source, {
    filename: this.resourcePath,
    jsc: { target: 'es2020', parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } } },
    module: { type: 'es6' },
  })).then(result => done(null, result.code), done);
};
