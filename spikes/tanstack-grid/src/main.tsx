import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installPerf } from './perf';
import './styles.css';

// No StrictMode: it double-invokes render/effects in dev, which would pollute the
// frame-timing and DOM-count measurements this spike exists to capture.
installPerf();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(<App />);
