/*====
RDS
======*/

variable "db_user" {}
variable "db_password" {}
variable "db_name" {
  default = "main"
}


/* subnet used by rds */
resource "aws_db_subnet_group" "rds_subnet_group" {
  name        = "${terraform.workspace}-rds-subnet-group"
  description = "RDS subnet group"
  subnet_ids  = [for subnet in aws_subnet.private : subnet.id]

  depends_on = [
    "aws_subnet.private"
  ]
}

resource "aws_db_instance" "rds" {
  count = "${terraform.workspace == "staging" ? 1 : 0}"
  identifier             = "${terraform.workspace}-database-pg"
  allocated_storage      = "${var.db_allocated_storage}"
  engine                 = "postgres"
  engine_version         = "10.9"
  allow_major_version_upgrade = true
  instance_class         = "db.t2.micro"
  name                   = "${var.db_name}"
  username               = "${var.db_user}"
  password               = "${var.db_password}"
  db_subnet_group_name   = "${aws_db_subnet_group.rds_subnet_group.id}"
  vpc_security_group_ids = ["${aws_security_group.sg_db_5432_ingress.id}"]

  skip_final_snapshot    = true
}

resource "aws_rds_cluster" "pg_rds" {
  count = "${terraform.workspace != "staging" ? 1 : 0}"
  cluster_identifier      = "${terraform.workspace}-database-aurora-pg"
  engine                  = "aurora-postgresql"
  engine_version          = "10.9"
  engine_mode             = "provisioned"
  database_name           = "${var.db_name}"
  master_username         = "${var.db_user}"
  master_password         = "${var.db_password}"
  backup_retention_period = 5
  db_subnet_group_name   = "${aws_db_subnet_group.rds_subnet_group.id}"
  vpc_security_group_ids = ["${aws_security_group.sg_db_5432_ingress.id}"]
  preferred_backup_window = "07:00-09:00"
  skip_final_snapshot     = true
  final_snapshot_identifier = "final"
  storage_encrypted       = true
}

resource "aws_rds_cluster_instance" "cluster_instances" {
  count = "${terraform.workspace != "staging" ? 1 : 0}"
  identifier         = "aurora-pg-clusterinstance-${count.index}"
  cluster_identifier = "${aws_rds_cluster.pg_rds[0].id}"
  instance_class     = "db.t3.medium"
  engine             = "aurora-postgresql"
  engine_version     = "10.9"
}
