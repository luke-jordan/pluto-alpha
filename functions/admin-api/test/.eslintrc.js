module.exports = {
    'rules': {
        'no-undefined': 'off',
        'no-process-env': 'off',
        'max-lines-per-function': 'off',
        'max-classes-per-file': 'off',
        'no-magic-numbers': 'off',
	    'no-underscore-dangle': 'off',
        'no-sync': 'off' // because we read in the API GW event and using promisify etc just not worth it
    }
}
