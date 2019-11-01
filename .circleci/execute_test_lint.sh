#! /bin/sh

CWD=$PWD
MODULE_OR_FUNCTION=$1
SKIP_OPTION=$2

echo "Executing tests, links on $MODULE_OR_FUNCTION"

cd $MODULE_OR_FUNCTION
ln -s $CWD/node_modules

if [ "$SKIP_OPTION" = "link-only" ]; then
    echo "Linking only, auxiliary function"
elif [ "$SKIP_OPTION" = "no-test" ]; then
    echo "Linting, but no test, still in development"
    npm run-script lint
else
    npm run-script lint; npm test; npm run-script generate-coverage
fi

cd $CWD
