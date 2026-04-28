/** filter — input: { items: any[], fn: string } */
export default {
    id: 'filter',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'filter', description: 'input: { items: any[], fn: string }', tags: ['core'] },
    source: `
        try {
            const items = input.items ?? (Array.isArray(input) ? input : []);
            const fn = input.fn ?? state.fn;
            if (!fn) return returnCallback({ output: { result: items, count: items.length }, state });
            const result = items.filter(new Function('return (' + fn + ')')());
            returnCallback({ output: { result, count: result.length }, state });
        } catch (err) {
            returnCallback({ output: { result: [], count: 0, error: err.message }, state });
        }
    `,
    interface: {
        inputs:  { items: { type: 'array', required: true }, fn: { type: 'string' } },
        outputs: { result: { type: 'array' }, count: { type: 'number' }, error: { type: 'string' } }
    }
};
