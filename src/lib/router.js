import { useEffect, useState } from 'react';

// Tiny hash router - no routing dependency, works behind any static file server.
export function useRoute() {
  const read = () => (window.location.hash.replace(/^#/, '') || '/').split('?')[0];
  const [path, setPath] = useState(read);
  useEffect(() => {
    const on = () => setPath(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return path;
}

export const navigate = (path) => (window.location.hash = path);
