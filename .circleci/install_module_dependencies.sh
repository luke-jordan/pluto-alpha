#!/bin/sh

if [ ! -e node_modules ]; then
	echo "Cached restore unsuccesful, execute NPM install"
	npm install
else
	echo "Cached restore successful, abort NPM install"
fi

echo "Node modules in place, symlink for tests"
