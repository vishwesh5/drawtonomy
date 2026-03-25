import { useMemo, useState } from 'react';
import { ControlPanel, type FrontendConfig } from './components/ControlPanel';

const defaultConfig: FrontendConfig = {
  drawtonomyBaseUrl: 'http://localhost:3000',
  extensionManifestUrl: '',
  projectTitle: 'My Drawtonomy Workspace'
};

function normalizeUrl(base: string): string {
  return base.replace(/\/+$/, '');
}

function buildEmbedUrl(config: FrontendConfig): string {
  const url = new URL(normalizeUrl(config.drawtonomyBaseUrl));

  if (config.extensionManifestUrl.trim()) {
    url.searchParams.set('ext', config.extensionManifestUrl.trim());
  }

  return url.toString();
}

export function App() {
  const [draft, setDraft] = useState<FrontendConfig>(defaultConfig);
  const [activeConfig, setActiveConfig] = useState<FrontendConfig>(defaultConfig);

  const embedUrl = useMemo(() => buildEmbedUrl(activeConfig), [activeConfig]);

  return (
    <div className="layout">
      <aside>
        <ControlPanel value={draft} onChange={setDraft} onLaunch={() => setActiveConfig(draft)} />
        <section className="panel">
          <h3>Current Session</h3>
          <ul>
            <li>
              <strong>Title:</strong> {activeConfig.projectTitle}
            </li>
            <li>
              <strong>Embed URL:</strong>
              <br />
              <code>{embedUrl}</code>
            </li>
          </ul>
        </section>
      </aside>

      <main>
        <header>
          <h1>{activeConfig.projectTitle}</h1>
          <p className="muted">The iframe below is your drawtonomy frontend container.</p>
        </header>

        <iframe
          title="drawtonomy"
          src={embedUrl}
          className="canvas"
          allow="clipboard-read; clipboard-write"
        />
      </main>
    </div>
  );
}
