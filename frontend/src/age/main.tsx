import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './age.css';
import { PageAge } from './PageAge';
import { PageTelephone } from './PageTelephone';
import { CHEMIN_TELEPHONE } from './suivi';

const Page = window.location.pathname === CHEMIN_TELEPHONE ? PageTelephone : PageAge;
createRoot(document.getElementById('racine')!).render(<StrictMode><Page /></StrictMode>);
