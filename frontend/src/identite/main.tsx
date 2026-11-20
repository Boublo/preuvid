import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../age/age.css';
import './identite.css';
import { PageIdentite } from './PageIdentite';

createRoot(document.getElementById('racine')!).render(<StrictMode><PageIdentite /></StrictMode>);
