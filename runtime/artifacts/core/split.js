/** split — input: { data: string|any[], delimiter?, size? } */
export default {
    id: 'split',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'split', description: 'input: { data: string|any[], delimiter?, size? }', tags: ['core'] },
    source: `
        const data = input.data ?? input;
        const delimiter = input.delimiter ?? state.delimiter ?? ',';
        const size = input.size ?? state.size;

        if (typeof data === 'string') {
            returnCallback({ output: { result: data.split(delimiter) }, state });
            return;
        }

        if (Array.isArray(data) && size) {
            const chunks = [];
            for (let i = 0; i < data.length; i += size) chunks.push(data.slice(i, i + size));
            returnCallback({ output: { result: chunks }, state });
            return;
        }

        returnCallback({ output: { result: Array.isArray(data) ? data : [data] }, state });
    `,
    interface: {
        inputs:  { data: { type: 'any', required: true }, delimiter: { type: 'string' }, size: { type: 'number' } },
        outputs: { result: { type: 'array' } }
    }
};
