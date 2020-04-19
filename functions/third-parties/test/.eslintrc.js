module.exports = {
    'rules': {
        'max-classes-per-file': 'off',
        'no-process-env': 'off',
        'max-lines-per-function': 'off',
        'no-magic-numbers': 'off',
        'no-underscore-dangle': 'off',
        'no-mixed-operators': 'off',
        'id-length': 'off',
        'no-sync': 'off' // because we read in the API GW event and using promisify etc just not worth it
    }
}
