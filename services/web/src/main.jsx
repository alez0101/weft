import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import './styles/shell.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);
