/**
 * What an update changes in an installed app's settings (see settingsDiff in lib/configForm.js): new settings with
 * the value they get, settings that disappear with the value they have, and settings whose definition changed.
 */
export function SettingsDiff({ diff, from, to, oldKnown, copied = false }) {
  if (!diff) return null;
  // copied: a new instance next to the old one gets its settings; update: the instance keeps them
  const lead = copied ? 'Inställningarna kopieras från den installerade appen.' : '';
  if (!diff.any) {
    return (
      <div className="info-box">
        {lead} Från version <strong>{from}</strong> till <strong>{to}</strong>. Inställningarna är desamma i båda versionerna och följer med som de är.
      </div>
    );
  }
  return (
    <div className="settings-diff">
      <p>
        {lead} Från version <strong>{from}</strong> till <strong>{to}</strong>. Så här ändras inställningarna:
      </p>
      {diff.added.length > 0 && (
        <Group kind="added" title={`Nya (${diff.added.length})`} hint="Får värdet nedan om du inte ändrar det i formuläret.">
          {diff.added.map((r) => (
            <Row key={r.name} r={r} value={r.required ? 'måste fyllas i' : r.value} />
          ))}
        </Group>
      )}
      {diff.changed.length > 0 && (
        <Group kind="changed" title={`Ändrade (${diff.changed.length})`} hint={copied ? 'Värdet kopieras. Kontrollera dem i formuläret.' : 'Ditt värde behålls. Kontrollera dem i formuläret.'}>
          {diff.changed.map((r) => (
            <Row key={r.name} r={r} value={r.value} notes={r.notes} problem={r.problem} />
          ))}
        </Group>
      )}
      {diff.removed.length > 0 && (
        <Group kind="removed" title={`Försvinner (${diff.removed.length})`} hint={copied ? 'Finns inte i den nya versionen och kopieras inte. Den installerade appen behåller dem.' : 'Finns inte i den nya versionen och tas bort ur inställningarna när du uppdaterar.'}>
          {diff.removed.map((r) => (
            <Row key={r.name} r={r} value={r.value} />
          ))}
        </Group>
      )}
      {diff.unknown.length > 0 && (
        <Group kind="unknown" title={`Okända (${diff.unknown.length})`} hint={oldKnown ? 'Fanns inte i formuläret i någon av versionerna. De behålls som de är.' : 'Den nya versionen har dem inte, och den gamla versionens inställningar gick inte att läsa. De behålls som de är.'}>
          {diff.unknown.map((r) => (
            <Row key={r.name} r={r} value={r.value} />
          ))}
        </Group>
      )}
      {diff.unchanged > 0 && <p className="muted small">{diff.unchanged === 1 ? '1 inställning är oförändrad.' : `${diff.unchanged} inställningar är oförändrade.`}</p>}
    </div>
  );
}

function Group({ kind, title, hint, children }) {
  return (
    <section className={`diff-group diff-${kind}`}>
      <h4>{title}</h4>
      <p className="muted small">{hint}</p>
      <ul>{children}</ul>
    </section>
  );
}

function Row({ r, value, notes = [], problem }) {
  return (
    <li>
      <span className="diff-name">{r.label}</span>
      {r.label !== r.name && <code className="diff-key">{r.name}</code>}
      <span className="diff-value">{value}</span>
      {notes.length > 0 && <small className="muted diff-notes">{notes.join(' · ')}</small>}
      {problem && <small className="err diff-notes">{problem}</small>}
    </li>
  );
}
