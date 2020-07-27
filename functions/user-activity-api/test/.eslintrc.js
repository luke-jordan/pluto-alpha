module.exports = {
    'rules': {
        'no-process-env': 'off',
        'max-lines-per-function': 'off',
        'max-classes-per-file': 'off',
        'no-magic-numbers': 'off',
        'no-underscore-dangle': 'off',
        'no-undefined': 'off', // need it to mock some forms of behaviour
        'no-sync': 'off' // because we read in the API GW event and using promisify etc just not worth it
    }
}
