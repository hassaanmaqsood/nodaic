/** json.stringify — input: { data: any, pretty?: boolean } */
export default {
    id: 'jsonStringify',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'json.stringify', description: 'input: { data: any, pretty?: boolean }', tags: ['core'] },
    source: `
        try {
            const data = input.data ?? input;
            const pretty = input.pretty ?? state.pretty ?? false;
            returnCallback({ output: { json: JSON.stringify(data, null, pretty ? 2 : 0) }, state });
        } catch (err) {
            returnCallback({ output: { json: '', error: err.message }, state });
        }
    `,
    interface: {
        inputs:  { data: { type: 'any', required: true }, pretty: { type: 'boolean' } },
        outputs: { json: { type: 'string' }, error: { type: 'string' } }
    }
};
