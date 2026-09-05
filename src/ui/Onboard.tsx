import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import React, { useCallback, useState } from 'react';
import type { Config, ProviderName } from '../config';
import { fetchModels, PRESETS, type ProviderPreset } from '../providers';
import { Frame, Row } from './Pickers';

export type OnboardResult = {
  presetId: string;
  provider: ProviderName;
  baseURL: string;
  apiKey: string;
  model: string;
};

type Step =
  | { name: 'pick-provider' }
  | { name: 'base-url'; preset: ProviderPreset }
  | { name: 'api-key'; preset: ProviderPreset; baseURL: string }
  | { name: 'loading'; preset: ProviderPreset; baseURL: string; apiKey: string }
  | { name: 'pick-model'; preset: ProviderPreset; baseURL: string; apiKey: string; models: string[]; warning?: string }
  | { name: 'type-model'; preset: ProviderPreset; baseURL: string; apiKey: string; warning?: string };

const mask = (key: string) => (key.length <= 8 ? '*'.repeat(key.length) : `${key.slice(0, 4)}...${key.slice(-4)}`);

const MANUAL_ENTRY = '__type_it__';

/**
 * Provider onboarding: pick a preset, supply a key, then choose a model from the
 * server's own /models list. Rendered in place of the prompt input, so it owns
 * the keyboard while open.
 */
export function Onboard({
  current,
  onDone,
  onCancel,
}: {
  current: Config;
  onDone: (result: OnboardResult) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>({ name: 'pick-provider' });
  const [draft, setDraft] = useState('');

  useInput(
    (_input, key) => {
      if (key.escape) onCancel();
    },
    { isActive: step.name !== 'loading' },
  );

  const loadModels = useCallback(
    async (preset: ProviderPreset, baseURL: string, apiKey: string) => {
      setStep({ name: 'loading', preset, baseURL, apiKey });
      const { models, warning } = await fetchModels({ ...preset, baseURL }, apiKey);
      setDraft('');
      if (models.length === 0) {
        setStep({ name: 'type-model', preset, baseURL, apiKey, ...(warning ? { warning } : {}) });
      } else {
        setStep({ name: 'pick-model', preset, baseURL, apiKey, models, ...(warning ? { warning } : {}) });
      }
    },
    [],
  );

  const afterBaseUrl = useCallback(
    (preset: ProviderPreset, baseURL: string) => {
      const fromEnv = preset.envKey ? process.env[preset.envKey] : undefined;
      const key = preset.keyless ? 'local' : (fromEnv ?? '');
      if (key) return void loadModels(preset, baseURL, key);
      setDraft('');
      setStep({ name: 'api-key', preset, baseURL });
    },
    [loadModels],
  );

  const pickProvider = useCallback(
    (preset: ProviderPreset) => {
      if (preset.baseURL) return afterBaseUrl(preset, preset.baseURL);
      setDraft('');
      setStep({ name: 'base-url', preset });
    },
    [afterBaseUrl],
  );

  switch (step.name) {
    case 'pick-provider': {
      const items = PRESETS.map((p) => ({
        key: p.id,
        label: p.id === current.presetId ? `${p.label}  (current)` : p.label,
        value: p.id,
      }));
      return (
        <Frame title="Choose a provider" hint="up/down to move, enter to select, esc to cancel">
          <SelectInput
            items={items}
            limit={12}
            initialIndex={Math.max(
              0,
              PRESETS.findIndex((p) => p.id === (current.presetId ?? current.provider)),
            )}
            onSelect={(item) => {
              const preset = PRESETS.find((p) => p.id === item.value);
              if (preset) pickProvider(preset);
            }}
          />
        </Frame>
      );
    }

    case 'base-url':
      return (
        <Frame title={`${step.preset.label}: endpoint URL`} hint="e.g. https://host/v1 - enter to continue">
          <Row label="URL">
            <TextInput
              value={draft}
              onChange={setDraft}
              onSubmit={(v) => v.trim() && afterBaseUrl(step.preset, v.trim())}
              placeholder="https://..."
            />
          </Row>
        </Frame>
      );

    case 'api-key':
      return (
        <Frame
          title={`${step.preset.label}: API key`}
          hint={`stored in the shiro config file${step.preset.envKey ? `, or set ${step.preset.envKey} instead` : ''}`}
        >
          <Row label="key">
            <TextInput
              value={draft}
              onChange={setDraft}
              mask="*"
              onSubmit={(v) => v.trim() && void loadModels(step.preset, step.baseURL, v.trim())}
              placeholder={step.preset.keyHint ?? 'paste it here'}
            />
          </Row>
        </Frame>
      );

    case 'loading':
      return (
        <Frame title={`${step.preset.label}: fetching models`} hint={step.baseURL}>
          <Text color="yellow">
            <Spinner type="dots" /> <Text dimColor>GET {step.baseURL}/models</Text>
          </Text>
        </Frame>
      );

    case 'pick-model': {
      const items = [
        ...step.models.map((m) => ({ key: m, label: m, value: m })),
        { key: MANUAL_ENTRY, label: 'type a model id myself...', value: MANUAL_ENTRY },
      ];
      return (
        <Frame
          title={`${step.preset.label}: choose a model`}
          hint={`${step.models.length} models - key ${mask(step.apiKey)}`}
          warning={step.warning}
        >
          <SelectInput
            items={items}
            limit={10}
            initialIndex={Math.max(0, step.models.indexOf(current.model))}
            onSelect={(item) => {
              if (item.value === MANUAL_ENTRY) {
                setDraft('');
                setStep({ name: 'type-model', preset: step.preset, baseURL: step.baseURL, apiKey: step.apiKey });
                return;
              }
              onDone({
                presetId: step.preset.id,
                provider: step.preset.kind,
                baseURL: step.baseURL,
                apiKey: step.apiKey,
                model: item.value,
              });
            }}
          />
        </Frame>
      );
    }

    case 'type-model':
      return (
        <Frame title={`${step.preset.label}: model id`} hint="enter to finish, esc to cancel" warning={step.warning}>
          <Row label="model">
            <TextInput
              value={draft}
              onChange={setDraft}
              onSubmit={(v) =>
                v.trim() &&
                onDone({
                  presetId: step.preset.id,
                  provider: step.preset.kind,
                  baseURL: step.baseURL,
                  apiKey: step.apiKey,
                  model: v.trim(),
                })
              }
              placeholder="model-id"
            />
          </Row>
        </Frame>
      );
  }
}
