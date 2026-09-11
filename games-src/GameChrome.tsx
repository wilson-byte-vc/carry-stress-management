import { createContext, useContext, useState } from 'react';

const SoundContext = createContext({ enabled: false, toggle: () => {} });
export function GameProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem('carry.games.sound') === 'true'; } catch { return false; }
  });
  function toggle() {
    setEnabled(value => {
      try { localStorage.setItem('carry.games.sound', String(!value)); } catch {}
      return !value;
    });
  }
  return <SoundContext.Provider value={{ enabled, toggle }}>{children}</SoundContext.Provider>;
}
export function ExitLink() { return <a href="/games" className="exit-link">← Back to games</a>; }
export function SoundToggle() {
  const { enabled, toggle } = useContext(SoundContext);
  return <button className="exit-link" style={{ left: 'auto', right: 16 }} onClick={toggle} aria-pressed={enabled}>Sound {enabled ? 'on' : 'off'}</button>;
}
export function useSoundEnabled() { return useContext(SoundContext).enabled; }
// The Flask application owns tasks. Games use fictional labels and never mutate them.
export function useCarry() { return { state: { tasks: [] as { status: string; title: string }[] } }; }
