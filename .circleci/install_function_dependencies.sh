#!/bin/sh

if [ ! -e node_modules ]; then
	echo "Cached restore unsuccesful, execute NPM install"
	npm install
else
	echo "Cached restore successful, abort NPM install"
fi

cp -r modules/* node_modules
echo "All modules in place, ready for symlinks"
