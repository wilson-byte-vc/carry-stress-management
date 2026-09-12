// Reuse the original games without running a second web server.
const path = require('node:path');
const fs = require('node:fs');
const swc = require('../website_codeconnection/node_modules/next/dist/build/swc');
const { webpack } = require('../website_codeconnection/node_modules/next/dist/compiled/webpack/webpack');
const root = path.resolve(__dirname, '..');
webpack({
  mode: 'production',
  optimization: { minimize: false },
  entry: path.join(root, 'games-src/index.tsx'),
  output: { path: path.join(root, 'static/games'), filename: 'games.js', clean: false },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    modules: [path.join(root, 'website_codeconnection/node_modules'), 'node_modules'],
    alias: {
      '@/components/games/GameChrome': path.join(root, 'games-src/GameChrome.tsx'),
      '@/hooks/useCarry': path.join(root, 'games-src/GameChrome.tsx'),
      '@': path.join(root, 'website_codeconnection'),
    },
  },
  module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(__dirname, 'games-loader.cjs') }] },
  performance: { hints: false },
}, async (error, stats) => {
  if (error || stats.hasErrors()) { console.error(error || stats.toString({ all: false, errors: true })); process.exitCode = 1; }
  else {
    try {
      await swc.loadBindings();
      const output = path.join(root, 'static/games/games.js');
      const result = await swc.minify(fs.readFileSync(output, 'utf8'), { compress: true, mangle: true, format: { comments: 'some' } });
      fs.writeFileSync(output, result.code);
      fs.copyFileSync(path.join(root, 'website_codeconnection/app/globals.css'), path.join(root, 'static/games/games.css'));
      const licenses = ['react', 'react-dom', 'scheduler', 'three'].map(name => {
        const license = fs.readFileSync(path.join(root, 'website_codeconnection/node_modules', name, 'LICENSE'), 'utf8');
        return `${name}\n${license}`;
      });
      fs.writeFileSync(path.join(root, 'static/games/LICENSES.txt'), licenses.join('\n\n'));
      console.log(`Built games: ${Math.round(fs.statSync(output).size / 1024)} KiB`);
    } catch (error) { console.error(error); process.exitCode = 1; }
  }
});
