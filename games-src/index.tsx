import { createRoot } from 'react-dom/client';
import CrushGame from '../website_codeconnection/app/games/crush/page';
import BreakGame from '../website_codeconnection/app/games/break/page';
import TargetsGame from '../website_codeconnection/app/games/targets/page';
import { GameProvider } from './GameChrome';
const root = document.getElementById('game-root')!;
const games = { crush: CrushGame, break: BreakGame, targets: TargetsGame };
const Game = games[root.dataset.game as keyof typeof games];
createRoot(root).render(<GameProvider><Game /></GameProvider>);
