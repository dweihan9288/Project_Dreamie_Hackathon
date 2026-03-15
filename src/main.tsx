import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

/**
 * Main Entry Point
 * 
 * Bootstraps the React application by rendering the root App component
 * into the DOM element with the ID 'root'.
 * StrictMode is enabled to highlight potential problems in the application.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
