import { useEffect, useState } from 'react';
import { lynx } from '../api/lynx.js';
import { backend } from '../api/backend.js';
import { ensureGithubVersion } from '../lib/install.js';
import { cleanValues, initialValues, validate } from '../lib/configForm.js';
import { ConfigForm } from './ConfigForm.jsx';
import { Field, Modal, errText } from './Modal.jsx';

/**
 * Install, update or change the settings of an edge app on one installation.
 *   job.mode: 'install' | 'update' | 'settings'
 *   job.github: { owner, repo, tag } - the version comes from GitHub (uploaded to IoT Open when needed)
 *   job.app + job.version: an app and version that already exist in IoT Open
 *   job.instance: the installed instance (update, settings)
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

  useEffect(() => {
    let alive = true;
    (async () => {
      let app = job.app;
      let version = job.version || job.instance?.version;
      if (job.github) {
        setStep('Hämtar appen från GitHub…');
        const pkg = await backend.package(job.github.owner, job.github.repo, job.github.tag);
        if (!alive) return;
        ({ app, version } = await ensureGithubVersion(lynx, { orgId: installation.organization_id, pkg, onStep: (s) => alive && setStep(s) }));
      }
      setStep('Läser appens inställningar…');
      const options = (await lynx.edgeAppOptions(app.id, version)) || {};
      if (!alive) return;
      setReady({ app, version, options });
      setValues(initialValues(options, job.instance?.config));
      setName(job.instance?.name || app.name || '');
    })().catch((e) => alive && setError(errText(e)));
    return () => {
      alive = false;
    };
  }, [job, installation.organization_id]);

  const save = async () => {
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
      const body = { app_id: ready.app.id, version: ready.version, name: name.trim() || ready.app.name, config: cleanValues(ready.options, cfg) };
      if (job.mode === 'install') await lynx.createInstance(iid, body);
      else await lynx.updateInstance(iid, { ...job.instance, ...body });
      onDone();
    } catch (e) {
      setError(errText(e));
      setSaving(false);
    }
  };

  const title =
    job.mode === 'install' ? `Installera ${job.title || ready?.app?.name || ''}` : job.mode === 'update' ? `Uppdatera ${job.instance.name}` : `Inställningar för ${job.instance.name}`;
  const action = job.mode === 'install' ? 'Installera' : job.mode === 'update' ? `Uppdatera till ${ready?.version || ''}` : 'Spara';

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
            <button type="button" className="btn primary" onClick={save} disabled={saving}>
              {saving ? 'Sparar…' : action}
            </button>
          </>
        )
      }
    >
      {error && <div className="error-box">{error}</div>}
      {!ready && !error && (
        <div className="progress">
          <span className="spinner" aria-hidden="true" />
          {step}
        </div>
      )}
      {ready && (
        <>
          {job.mode === 'update' && (
            <div className="info-box">
              Från version <strong>{job.instance.version}</strong> till <strong>{ready.version}</strong>. Nuvarande inställningar följer med; kontrollera nya fält innan du uppdaterar.
            </div>
          )}
          <Field label="Namn på installerad app" help="Visas i listan över appar på installationen.">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {raw ? (
            <Field label="Inställningar (JSON)" help="Sparas som appens config i IoT Open.">
              <textarea className="mono" rows={14} value={rawText} onChange={(e) => setRawText(e.target.value)} spellCheck={false} />
            </Field>
          ) : (
            <ConfigForm iid={iid} options={ready.options} values={values} onChange={setValues} errors={errors} />
          )}
        </>
      )}
    </Modal>
  );
}
