import { useEffect, useState } from 'react';
import { lynx } from '../api/lynx.js';
import { backend } from '../api/backend.js';
import { ensureGithubVersion } from '../lib/install.js';
import { cleanValues, initialValues, sameConfig, settingsDiff, uniqueName, validate, withoutRemoved } from '../lib/configForm.js';
import { ConfigForm } from './ConfigForm.jsx';
import { SettingsDiff } from './SettingsDiff.jsx';
import { Field, Modal, errText } from './Modal.jsx';

/**
 * Install, update or change the settings of an edge app on one installation.
 *   job.mode: 'install' | 'update' | 'settings'
 *   job.github: { owner, repo, tag } - the version comes from GitHub (uploaded to IoT Open when needed)
 *   job.app + job.version: an app and version that already exist in IoT Open
 *   job.instance: the installed instance (update, settings)
 *   job.from: install only - an installed instance of the same app to run next to: its settings are copied
 *   job.copy: install only - an installed instance to copy: the same app, version and settings, as a new instance
 */
export function InstallDialog({ installation, job, onClose, onDone }) {
  const iid = installation.id;
  const [step, setStep] = useState('Förbereder…');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(null); // { app, version, options }
  const [values, setValues] = useState({});
  const [name, setName] = useState('');
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState('');
  // the instance as it was when the form was filled in, and whether it has changed since (another front end, or the
  // app itself writing its form, like För länge from 0.4)
  const [loaded, setLoaded] = useState(job.instance || null);
  const [changed, setChanged] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      let app = job.app;
      let version = job.version || job.instance?.version || job.copy?.version;
      let sameAs = null;
      if (job.github) {
        setStep('Hämtar appen från GitHub…');
        const pkg = await backend.package(job.github.owner, job.github.repo, job.github.tag);
        if (!alive) return;
        ({ app, version, sameAs } = await ensureGithubVersion(lynx, { orgId: installation.organization_id, pkg, onStep: (s) => alive && setStep(s) }));
      }
      setStep('Läser appens inställningar…');
      const options = (await lynx.edgeAppOptions(app.id, version)) || {};
      // an update, or a new instance next to an installed one: the installed version's settings too, to show what
      // changes (null when they cannot be read)
      // the installed instance read again, so the form starts from what applies now
      const current = job.instance ? (await freshInstance(iid, job.instance.id)) || job.instance : null;
      if (!alive) return;
      if (current) setLoaded(current);
      const base = job.mode === 'update' ? current : job.mode === 'install' ? job.from || job.copy : null;
      let oldOptions = null;
      if (base && base.version !== version) {
        oldOptions = await lynx.edgeAppOptions(base.app_id ?? app.id, base.version).catch(() => null);
      }
      if (!alive) return;
      const diff = base && base.version !== version ? settingsDiff(oldOptions, options, base.config) : null;
      setReady({ app, version, options, sameAs, diff, oldKnown: !!oldOptions });
      // a new instance gets a name no instance on the installation has, so ten copies can be told apart
      let taken = [];
      if (job.mode === 'install') taken = ((await lynx.instances(iid).catch(() => [])) || []).map((i) => i.name);
      if (!alive) return;
      setValues(initialValues(options, job.mode === 'settings' ? current?.config : base?.config));
      if (job.mode !== 'install') setName(job.instance?.name || app.name || '');
      else setName(uniqueName(job.from ? `${job.from.name} ${version}` : job.copy ? job.copy.name : app.name, taken));
    })().catch((e) => alive && setError(errText(e)));
    return () => {
      alive = false;
    };
  }, [job, installation.organization_id, iid]);

  /** The newer settings in the form, instead of the ones the person was editing. */
  const loadNewer = () => {
    setLoaded(changed);
    setValues(initialValues(ready.options, changed.config));
    if (changed.name) setName(changed.name);
    setChanged(null);
    setRaw(false);
  };

  const save = async (force = false) => {
    let cfg = values;
    if (raw) {
      try {
        cfg = JSON.parse(rawText || '{}');
      } catch {
        setError('Inställningarna är inte giltig JSON.');
        return;
      }
    }
    const errs = validate(ready.options, cfg);
    setErrors(errs);
    if (Object.keys(errs).length) {
      setError('Kontrollera de markerade fälten.');
      if (raw) setRaw(false);
      setValues(cfg);
      return;
    }
    setError('');
    setSaving(true);
    try {
      // changed by someone or something else since the form was filled in: ask before overwriting
      let target = loaded || job.instance;
      if (job.mode !== 'install') {
        const now = await freshInstance(iid, job.instance.id);
        if (now && !force && !sameConfig(now.config, loaded?.config)) {
          setChanged(now);
          setSaving(false);
          return;
        }
        if (now) target = now;
      }
      setChanged(null);
      // settings the new version no longer has are not carried over
      const body = { app_id: ready.app.id, version: ready.version, name: name.trim() || ready.app.name, config: cleanValues(ready.options, withoutRemoved(cfg, ready.diff)) };
      if (job.mode === 'install') await lynx.createInstance(iid, body);
      else await lynx.updateInstance(iid, { ...target, ...body });
      onDone(body.name);
    } catch (e) {
      setError(errText(e));
      setSaving(false);
    }
  };

  const title =
    job.mode === 'install' && job.from ? `Installera ${ready?.version || 'ny version'} bredvid ${job.from.name}` : job.mode === 'install' && job.copy ? `Kopiera ${job.copy.name}` : job.mode === 'install' ? `Installera ${job.title || ready?.app?.name || ''}` : job.mode === 'update' ? `Uppdatera ${job.instance.name}` : `Inställningar för ${job.instance.name}`;
  // a GitHub release whose code IoT Open already has under the installed version's name: nothing to update
  const noChange = job.mode === 'update' && !!ready && ready.version === job.instance.version;
  const action = job.mode === 'install' ? 'Installera' : job.mode === 'update' && !noChange ? `Uppdatera till ${ready?.version || ''}` : 'Spara';

  return (
    <Modal
      title={title}
      wide
      onClose={saving ? () => {} : onClose}
      footer={
        ready && (
          <>
            <button type="button" className="link-btn small" onClick={() => {
              if (!raw) setRawText(JSON.stringify(cleanValues(ready.options, values), null, 2));
              else {
                try {
                  setValues(JSON.parse(rawText || '{}'));
                } catch {
                  setError('Inställningarna är inte giltig JSON.');
                  return;
                }
              }
              setRaw(!raw);
            }}>
              {raw ? 'Visa formulär' : 'Avancerat (JSON)'}
            </button>
            <span className="grow" />
            <button type="button" className="btn" onClick={onClose} disabled={saving}>
              Avbryt
            </button>
            <button type="button" className="btn primary" onClick={() => save(false)} disabled={saving}>
              {saving ? 'Sparar…' : action}
            </button>
          </>
        )
      }
    >
      {error && <div className="error-box">{error}</div>}
      {changed && (
        <div className="warn-box">
          <strong>Inställningarna har ändrats sedan du öppnade dem</strong>, i ett annat fönster, av någon annan eller av
          appen själv. Om du sparar ersätter dina värden de nya.
          <div className="box-actions">
            <button type="button" className="btn" onClick={loadNewer}>
              Visa de nya
            </button>
            <button type="button" className="btn primary" onClick={() => save(true)} disabled={saving}>
              Spara mina ändå
            </button>
          </div>
        </div>
      )}
      {!ready && !error && (
        <div className="progress">
          <span className="spinner" aria-hidden="true" />
          {step}
        </div>
      )}
      {ready && (
        <>
          {job.mode === 'update' && noChange && (
            <div className="info-box">
              Version <strong>{ready.sameAs || job.github?.tag}</strong> har samma kod som den installerade <strong>{ready.version}</strong>, så det finns inget att uppdatera. Du kan ändra och spara inställningarna här.
            </div>
          )}
          {job.mode === 'update' && !noChange && <SettingsDiff diff={ready.diff} from={job.instance.version} to={ready.version} oldKnown={ready.oldKnown} />}
          {job.copy && (
            <div className="info-box">
              En ny instans av <strong>{ready.app.name}</strong> version <strong>{ready.version}</strong> med inställningarna från <strong>{job.copy.name}</strong>. Ändra det som ska skilja dem åt, till exempel en port, funktioner eller ämnen i MQTT. {job.copy.name} påverkas inte.
            </div>
          )}
          {job.from && (
            <>
              <div className="warn-box">
                <strong>{job.from.name}</strong> (version {job.from.version}) finns kvar och fortsätter att köras. Båda körs samtidigt på edge clienten, så kontrollera att de inte krockar, till exempel om samma port, samma funktioner eller samma ämnen i MQTT. Ta bort den gamla när den nya fungerar.
              </div>
              <SettingsDiff diff={ready.diff} from={job.from.version} to={ready.version} oldKnown={ready.oldKnown} copied />
            </>
          )}
          <Field label="Namn på installerad app" help="Visas i listan över appar på installationen.">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {raw ? (
            <Field label="Inställningar (JSON)" help="Sparas som appens config i IoT Open.">
              <textarea className="mono" rows={14} value={rawText} onChange={(e) => setRawText(e.target.value)} spellCheck={false} />
            </Field>
          ) : (
            <ConfigForm iid={iid} options={ready.options} values={values} onChange={setValues} errors={errors} marks={marksOf(ready.diff)} />
          )}
        </>
      )}
    </Modal>
  );
}

/** The instance as IoT Open has it now, or null when it cannot be read. */
async function freshInstance(iid, id) {
  const list = await lynx.instances(iid).catch(() => null);
  return (list || []).find((i) => i.id === id) || null;
}

/** Badges for the form: "Ny" on new settings, "Ändrad" on changed ones. */
function marksOf(diff) {
  if (!diff) return null;
  return Object.fromEntries([...diff.added.map((r) => [r.name, 'Ny']), ...diff.changed.map((r) => [r.name, 'Ändrad'])]);
}
