import React from 'react';
import ReactDOM from 'react-dom/client';
// Base styles first so per-tool stylesheets (video.css) can override them.
import './styles.css';
import App from './App';
import Hub from './Hub';
import VideoStudio from './video/VideoStudio';
import VoiceStudio from './voice/VoiceStudio';
import FaceSwapPage from './faceswap/FaceSwapPage';

/** Tiny path router: / → tool hub, /image → Image Studio, /video → Video Studio, /voice → Voice Studio, /faceswap → Face Swap. */
function route() {
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path === '/video') return <VideoStudio />;
  if (path === '/voice') return <VoiceStudio />;
  if (path === '/faceswap') return <FaceSwapPage />;
  if (path === '/image') return <App />;
  return <Hub />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{route()}</React.StrictMode>);
