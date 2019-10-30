#!/bin/sh

if [ ! -e node_modules ]; then
	echo "Cached restore unsuccesful, execute NPM install"
	npm install
	cp -r modules/* node_modules
else
	echo "Cached restore successful, abort NPM install"
fi

echo "All modules in place, ready for symlinks"
