import { useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { config } from '../api/config.js';
import { customServersAllowed, defaultServer, getServer, normalizeServer, saveServer, serverLabel, setServer } from '../api/server.js';

const MODE_KEY = 'am.loginMode';
const savedMode = () => {
  try {
    return localStorage.getItem(MODE_KEY) === 'apikey' ? 'apikey' : 'password';
  } catch {
    return 'password';
  }
};

export default function Login() {
  const { signIn, signIn2fa, signInApiKey } = useApp();
  const [mode, setMode] = useState(savedMode); // 'password' | 'apikey'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [twoFa, setTwoFa] = useState(null);
  const [code, setCode] = useState('');
  const [server, setServerText] = useState(() => (getServer() ? serverLabel() : ''));
  const [editServer, setEditServer] = useState(false);
  const defaultLabel = serverLabel(defaultServer());

  const switchMode = (m) => {
    setMode(m);
    setError('');
    setTwoFa(null);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      // the server is chosen before signing in; a 2FA step continues on the same server
      if (!twoFa) setServer(server.trim() ? normalizeServer(server) : null);
      if (mode === 'apikey') await signInApiKey(apiKey, remember);
      else if (twoFa) await signIn2fa(twoFa, code.trim(), remember);
      else await signIn(email, password, remember);
      saveServer(); // only a server that worked is remembered
    } catch (err) {
      if (err.twoFactor) {
        setTwoFa(err.tmpToken);
        setCode('');
      } else if (err.status === 401 || err.status === 403) {
        setError(mode === 'apikey' ? 'IoT Open godkände inte API-nyckeln.' : twoFa ? 'Fel kod. Försök igen.' : 'Fel e-post eller lösenord.');
      } else if (err.status === 429) setError('För många försök. Vänta en minut.');
      else if (err.status >= 500) setError(`Kunde inte nå IoT Open (HTTP ${err.status}).`);
      else if (err instanceof TypeError) setError(`Kunde inte nå ${serverLabel()}. Kontrollera serveradressen.`);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-form" onSubmit={submit}>
        <picture>
          <source srcSet="branding/iotopen-logo-white.svg" media="(prefers-color-scheme: dark)" />
          <img className="login-logo" src="branding/iotopen-logo.svg" alt="IoT Open" />
        </picture>
        <h1>{config.appTitle}</h1>
        <div className="seg login-mode" role="tablist" aria-label="Inloggningssätt">
          <button type="button" role="tab" aria-selected={mode === 'password'} className={mode === 'password' ? 'on' : ''} onClick={() => switchMode('password')}>
            E-post och lösenord
          </button>
          <button type="button" role="tab" aria-selected={mode === 'apikey'} className={mode === 'apikey' ? 'on' : ''} onClick={() => switchMode('apikey')}>
            API-nyckel
          </button>
        </div>

        {mode === 'apikey' ? (
          <label className="field">
            <span>API-nyckel</span>
            <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required autoFocus spellCheck={false} />
            <small className="muted">Skapas under din användare i IoT Open. Appar och edge clients hanteras med den användarens behörigheter.</small>
          </label>
        ) : !twoFa ? (
          <>
            <label className="field">
              <span>E-post</span>
              <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </label>
            <label className="field">
              <span>Lösenord</span>
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
          </>
        ) : (
          <>
            <div className="info-box">Ange koden från din autentiseringsapp eller ditt SMS.</div>
            <label className="field">
              <span>Verifieringskod</span>
              <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus required inputMode="numeric" autoComplete="one-time-code" />
            </label>
            <button type="button" className="link-btn small" onClick={() => setTwoFa(null)}>
              Avbryt och börja om
            </button>
          </>
        )}
        {customServersAllowed() && !twoFa && (
          <div className="server-pick">
            {editServer ? (
              <label className="field">
                <span>Server</span>
                <div className="row gap">
                  <input className="grow" value={server} onChange={(e) => setServerText(e.target.value)} placeholder={defaultLabel} spellCheck={false} autoCapitalize="off" inputMode="url" />
                  {server && (
                    <button type="button" className="btn" onClick={() => setServerText('')} title={`Tillbaka till ${defaultLabel}`}>
                      Standard
                    </button>
                  )}
                </div>
                <small className="muted">Tomt fält ger {defaultLabel}. En annan adress sparas i den här webbläsaren.</small>
              </label>
            ) : (
              <p className="muted small">
                Server: <strong>{server.trim() || defaultLabel}</strong>{' '}
                <button type="button" className="link-btn small" onClick={() => setEditServer(true)}>
                  Ändra
                </button>
              </p>
            )}
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Kom ihåg mig
        </label>
        {error && <div className="error-box">{error}</div>}
        <button className="btn primary block" disabled={busy}>
          {busy ? 'Loggar in…' : twoFa && mode === 'password' ? 'Verifiera' : 'Logga in'}
        </button>
      </form>
    </div>
  );
}
