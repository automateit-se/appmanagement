import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { loadConfig } from './api/config.js';
import './styles.css';

// "/appmanagement" -> "/appmanagement/": all URLs are relative to the app's directory, so it needs the trailing slash
const { pathname, search, hash } = window.location;
if (!pathname.endsWith('/') && !/\.[a-z0-9]+$/i.test(pathname)) {
  window.location.replace(`${pathname}/${search}${hash}`);
} else {
  loadConfig().then(() => createRoot(document.getElementById('root')).render(<App />));
}
