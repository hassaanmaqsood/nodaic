/** store.set — input: { key: string, value: any } */

export default {
    id: 'storeSet',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'store.set', description: 'input: { key: string, value: any }', tags: ['core'] },
    source: `
        globalThis._nodaicStore = globalThis._nodaicStore ?? {};
        globalThis._nodaicStore[input.key] = input.value;
        returnCallback({ output: { key: input.key, ok: true }, state });
    `,
    interface: {
        inputs:  { key: { type: 'string', required: true }, value: { type: 'any', required: true } },
        outputs: { key: { type: 'string' }, ok: { type: 'boolean' } }
    }
};
