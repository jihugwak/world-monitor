import './styles/main.css';
import { App } from './App';

const app = new App();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void app.init());
} else {
  void app.init();
}

window.addEventListener('beforeunload', () => app.destroy());
