/** json.parse — input: { json: string } */
export default {
    id: 'jsonParse',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'json.parse', description: 'input: { json: string }', tags: ['core'] },
    source: `
        try {
            const json = input.json ?? (typeof input === 'string' ? input : null);
            if (!json) throw new Error('No JSON string provided');
            returnCallback({ output: { data: JSON.parse(json), ok: true }, state });
        } catch (err) {
            returnCallback({ output: { data: null, ok: false, error: err.message }, state });
        }
    `,
    interface: {
        inputs:  { json: { type: 'string', required: true } },
        outputs: { data: { type: 'any' }, ok: { type: 'boolean' }, error: { type: 'string' } }
    }
};
