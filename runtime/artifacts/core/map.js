/** map — input: { items: any[], fn: string } */
export default {
    id: 'map',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'map', description: 'input: { items: any[], fn: string }', tags: ['core'] },
    source: `
        try {
            const items = input.items ?? (Array.isArray(input) ? input : []);
            const fn = input.fn ?? state.fn;
            if (!fn) return returnCallback({ output: { result: items }, state });
            const result = items.map(new Function('return (' + fn + ')')());
            returnCallback({ output: { result }, state });
        } catch (err) {
            returnCallback({ output: { result: [], error: err.message }, state });
        }
    `,
    interface: {
        inputs:  { items: { type: 'array', required: true }, fn: { type: 'string' } },
        outputs: { result: { type: 'array' }, error: { type: 'string' } }
    }
};
