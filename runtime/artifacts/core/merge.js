/** merge — input: { ...objects } */
export default {
    id: 'merge',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'merge', description: 'input: { ...objects }', tags: ['core'] },
    source: `
        const result = Object.assign(
            {},
            ...Object.values(input).filter(v => v && typeof v === 'object' && !Array.isArray(v))
        );
        returnCallback({ output: { result }, state });
    `,
    interface: {
        inputs:  { objects: { type: 'object', required: true } },
        outputs: { result: { type: 'object' } }
    }
};
