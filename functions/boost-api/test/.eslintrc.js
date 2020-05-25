module.exports = {
    'rules': {
        'no-process-env': 'off',
        'max-lines-per-function': 'off',
        'no-magic-numbers': 'off',
        'no-underscore-dangle': 'off',
        'no-useless-escape': 'off',
        'function-paren-newline': 'off', // annoying
        'no-sync': 'off' // because we read in the API GW event and using promisify etc just not worth it
    }
}
