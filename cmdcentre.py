import requests
import subprocess
import psutil
import pprint
import json
import os
import uuid
import psycopg2
import pandas.io.sql as sqlio

def prompt():
    inpt = input(':')
    if inpt == 'exit':
        return
    else:
        direct_command(inpt)
        prompt()

def direct_command(cmd):
    if cmd == 'psql':
        launch_postgres()
    elif cmd == 'setup_data':
        setup_data_structures()
    elif cmd == 'docker_up':
        launch_docker()
    else:
        print ("You entered : %s" % (inpt))


def open_cmd_in_new_terminal(cmd, folder = None):
    open_controller_cmd = "gnome-terminal --working-directory=%s -- %s" % (folder, cmd) if folder else "gnome-terminal -- %s" % cmd
    subprocess.Popen(open_controller_cmd, shell=True)


def run_psql_query(query_string):
    try:
        conn = psycopg2.connect("dbname=avalanche user=master password=alpineskiing host=localhost port=5430")
        curr = conn.cursor()
        dat = sqlio.read_sql_query(query_string, conn)
        return dat
    except (Exception, psycopg2.Error) as error:
        print ("Error while fetching data from PostgreSQL", error)
    finally:
        if (conn):
            curr.close()
            conn.close()


def launch_docker():
    command = "docker-compose up"
    open_cmd_in_new_terminal(command)


def launch_postgres():
    command = "psql -U master -p 5430 -h localhost -d avalanche"
    open_cmd_in_new_terminal(command)


def setup_data_structures():
    print("Okay, setting up data")
    subprocess.Popen('./basicsetup.sh', cwd='./templates', stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def open_account(user_fname="Luke", user_sname="Jordan", user_id=str(uuid.uuid4())):
    print("Creating account for for user %s %s with ID %s" % (user_fname, user_sname, user_id))
    create_request = { "ownerUserId": user_id, "userFirstName": user_sname, "userFamilyName": user_sname }
    command = "sls invoke local -f create --data '%s'" % (json.dumps(create_request))
    subprocess.Popen(command, cwd='./functions/account-api', env=dict(os.environ, DEBUG="u*"), shell=True)
    print("Done creating account")


def save_money(account_id, amount=100, currency="ZAR"):
    print("Okay, saving some money")
    save_request = { "accountId": account_id, "savedAmount": amount, "savedCurrency": currency }
    command = "sls invoke local -f save --data '%s'" % (json.dumps(save_request))
    print("Executing command: ", command)
    subprocess.Popen(command, cwd='./functions/save-transaction-api', env=dict(os.environ, DEBUG="u*"), shell=True)
    print("Okay, saved")


def list_accounts(print_rows = True):
    account_rows = run_psql_query("select account_id, user_first_name, user_last_name, creation_time from account_data.core_account_ledger")
    if print_rows:
        print(account_rows)
    return account_rows

if __name__ == "__main__":
    # execute only if run as a script
    prompt() 