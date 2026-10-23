/** The initial dependency graph contains only the DOM shell, catalog metadata and Canvas2D Pong. */
import './ui/floating-workspace.css';
import { launch } from './ui/launch';

launch.mount(() => import('./main'));
