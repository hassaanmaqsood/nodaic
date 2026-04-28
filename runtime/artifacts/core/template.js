/** template — input: { template: string, data: object } */
export default {
    id: 'template',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'template', description: 'input: { template: string, data: object }', tags: ['core'] },
    source: `
        const tpl = input.template ?? state.template ?? '';
        const data = input.data ?? input;
        const result = tpl.replace(
            /\\{\\{\\s*([\\w.]+)\\s*\\}\\}/g,
            (_, key) => {
                const val = key.split('.').reduce((o, k) => o?.[k], data);
                return val !== undefined ? String(val) : '';
            }
        );
        returnCallback({ output: { result }, state });
    `,
    interface: {
        inputs:  { template: { type: 'string', required: true }, data: { type: 'object' } },
        outputs: { result: { type: 'string' } }
    }
};
