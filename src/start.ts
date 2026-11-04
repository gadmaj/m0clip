/** The initial dependency graph contains only the DOM shell, catalog metadata and Canvas2D Pong. */
import './ui/floating-workspace.css';
import { launch } from './ui/launch';

let addingContent = false;
launch.onAddGameContent(() => {
  if (addingContent) return;
  addingContent = true;
  // Local game content parsing and model previews load only when the person asks for them.
  void import('./player/content-session').then(async ({ playerGameContent }) => {
    if (await playerGameContent.add()) launch.setPlayerBodies(playerGameContent.bodyOptions);
  }).catch(reportError).finally(() => { addingContent = false; });
});
launch.mount(() => import('./main'));
