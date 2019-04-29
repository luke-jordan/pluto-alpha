#! /bin/bash

function wipe_clean {
    bash ./wipeclean.sh
}

function docker_up {
    gnome-terminal -e 'docker-compose up'
    sleep 10 # todo : make this keep trying to ping until successful, instead
}

function basic_setup {
    cd ./templates
    bash ./basicsetup.sh
}

function activate_venv {
    source activate ua-local-dev
}

clean_containers=true
basic_data_setup=true
# deploy_serverless=true
activate_venv=false

while test $# -gt 0
do
    case "$1" in
        --quick) echo "Quick start, just put up containers"
            clean_containers=false
            basic_data_setup=false
            deploy_serverless=false
            activate_venv=false
            ;;
        -nc|--noclean) echo "Do not wipe containers clean"
            clean_containers=false
            ;;
        -nd|--nodata) echo "Do not set up basic data structures"
            basic_data_setup=false
            ;;
        -ds|--depsls) echo "Deploy serverless functions"
            deploy_serverless=false
            ;;
        -ve|--venv) echo "Activate virtual env"
            activate_venv=false
            ;;
        --*) echo "Bad option $1"
            ;;
        *) echo "Argument $1"
            ;;
    esac
    shift
done

if [ "$clean_containers" = true ] ; then
    wipe_clean
fi

if [ -z `docker ps -q --no-trunc | grep $(docker-compose ps -q localstack)` ]; then
    docker_up
else
    echo "Service containers already running, not launching"
fi

if [ "$basic_data_setup" = true ] ; then
    basic_setup
fi

if [ "$activate_venv" = true ] ; then
    activate_venv
fi

echo "Done, local environment should be good to go"

exit 0