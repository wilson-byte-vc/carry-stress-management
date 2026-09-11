A stress management Application 


Games are available at `/games` from the desktop and mobile navigation.
The three games reuse the React components in `website_codeconnection/app/games`.
Flask serves the compiled assets from `static/games`; no Next.js server is needed.
The existing Pressure Valve reset remains at `/game`.

After changing the source games, rebuild with `node scripts/build-games.cjs`
(using the dependencies installed in `website_codeconnection/node_modules`).
Commit the rebuilt assets with source changes so the Flask deployment stays in sync.
The integration in `games-src` supplies navigation and a browser-local sound setting;
Break the Pile uses fictional task labels and does not change the app's tasks.
