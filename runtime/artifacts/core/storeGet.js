/** store.get — input: { key: string, default?: any } */

export default {
    id: 'storeGet',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'store.get', description: 'input: { key: string, default?: any }', tags: ['core'] },
    source: `
        globalThis._nodaicStore = globalThis._nodaicStore ?? {};
        const found = input.key in globalThis._nodaicStore;
        returnCallback({ output: { value: found ? globalThis._nodaicStore[input.key] : (input.default ?? null), found }, state });
    `,
    interface: {
        inputs:  { key: { type: 'string', required: true }, default: { type: 'any' } },
        outputs: { value: { type: 'any' }, found: { type: 'boolean' } }
    }
};
