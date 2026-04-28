/** transform — input: { data: any, fn: string } */
export default {
    id: 'transform',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'transform', description: 'input: { data: any, fn: string }', tags: ['core'] },
    source: `
        try {
            const data = input.data ?? input;
            const fn = input.fn ?? state.fn;
            if (!fn) return returnCallback({ output: { result: data }, state });
            const result = new Function('return (' + fn + ')')()(data);
            returnCallback({ output: { result }, state });
        } catch (err) {
            returnCallback({ output: { result: null, error: err.message }, state });
        }
    `,
    interface: {
        inputs:  { data: { type: 'any', required: true }, fn: { type: 'string' } },
        outputs: { result: { type: 'any' }, error: { type: 'string' } }
    }
};
