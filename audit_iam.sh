echo "Making sure no wildcards in terraform files"

if grep -q -r --include "*.tf" ":\*"; then
    echo "Found wildcards in TF, likely security risk, narrow applicable scope first"
    exit 1
else
    echo "No wildcards find, continuing"
fi
