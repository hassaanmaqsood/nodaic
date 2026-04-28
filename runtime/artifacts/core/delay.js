/** delay — input: { ms: number, data: any } */
export default {
    id: 'delay',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'delay', description: 'input: { ms: number, data: any }', tags: ['core'] },
    source: `
        const ms = input.ms ?? state.ms ?? 1000;
        const data = input.data ?? input;
        setTimeout(() => returnCallback({ output: { data }, state }), ms);
    `,
    interface: {
        inputs:  { ms: { type: 'number' }, data: { type: 'any' } },
        outputs: { data: { type: 'any' } }
    }
};
