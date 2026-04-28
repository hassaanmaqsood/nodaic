/** branch — input: { condition: boolean, data: any } */
export default {
    id: 'branch',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'branch', description: 'input: { condition: boolean, data: any }', tags: ['core'] },
    source: `
        returnCallback({ output: input.condition ? { truePath: input.data } : { falsePath: input.data }, state });
    `,
    interface: {
        inputs:  { condition: { type: 'boolean', required: true }, data: { type: 'any' } },
        outputs: { truePath: { type: 'any' }, falsePath: { type: 'any' } }
    }
};
