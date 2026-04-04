import type { FormEvent } from 'react';

export interface FrontendConfig {
  drawtonomyBaseUrl: string;
  extensionManifestUrl: string;
  projectTitle: string;
}

interface ControlPanelProps {
  value: FrontendConfig;
  onChange: (next: FrontendConfig) => void;
  onLaunch: () => void;
}

export function ControlPanel({ value, onChange, onLaunch }: ControlPanelProps) {
  const set = (key: keyof FrontendConfig, nextValue: string) => {
    onChange({ ...value, [key]: nextValue });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onLaunch();
  };

  return (
    <form className="panel" onSubmit={handleSubmit}>
      <h2>Frontend Launcher</h2>
      <p className="muted">
        This app is a separate frontend shell that hosts drawtonomy and can optionally inject an extension.
      </p>

      <label>
        Drawtonomy URL
        <input
          value={value.drawtonomyBaseUrl}
          onChange={(event) => set('drawtonomyBaseUrl', event.target.value)}
          placeholder="http://localhost:3000"
          required
        />
      </label>

      <label>
        Extension manifest URL (optional)
        <input
          value={value.extensionManifestUrl}
          onChange={(event) => set('extensionManifestUrl', event.target.value)}
          placeholder="http://localhost:3001/manifest.json"
        />
      </label>

      <label>
        Workspace title
        <input
          value={value.projectTitle}
          onChange={(event) => set('projectTitle', event.target.value)}
          placeholder="Autonomous driving scenario"
        />
      </label>

      <button type="submit">Launch Drawtonomy</button>
    </form>
  );
}
