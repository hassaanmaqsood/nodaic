/** validate — input: { data: object, schema: object } */

export default {
    id: 'validate',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'validate', description: 'input: { data: object, schema: object }', tags: ['core'] },
    source: `
        function _validate(data, schema) {
            const result = { ...data };
            const errors = [];
            for (const [field, rules] of Object.entries(schema)) {
                if (rules.required && !(field in data)) {
                    errors.push(\`\${field} is required\`);
                    if (rules.default !== undefined) result[field] = rules.default;
                }
                if (field in data && rules.type && typeof data[field] !== rules.type) {
                    errors.push(\`\${field} must be \${rules.type}\`);
                }
                if (field in data && rules.enum && !rules.enum.includes(data[field])) {
                    errors.push(\`\${field} must be one of: \${rules.enum.join(', ')}\`);
                }
                if (!(field in data) && rules.default !== undefined) result[field] = rules.default;
            }
            return { result, errors, ok: errors.length === 0 };
        }

        const data = input.data ?? input;
        const schema = input.schema ?? state.schema ?? {};
        const { result, errors, ok } = _validate(data, schema);
        returnCallback({ output: { result, errors, ok }, state });
    `,
    interface: {
        inputs:  { data: { type: 'object', required: true }, schema: { type: 'object', required: true } },
        outputs: { result: { type: 'object' }, errors: { type: 'array' }, ok: { type: 'boolean' } }
    }
};
