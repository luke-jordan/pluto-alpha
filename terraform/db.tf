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
  identifier             = "${terraform.workspace}-database"
  allocated_storage      = "${var.db_allocated_storage}"
  engine                 = "${var.db_engine[terraform.workspace]}"
  engine_version         = "${var.db_engine_version[terraform.workspace]}"
  allow_major_version_upgrade = true
  instance_class         = "${var.db_instance_class[terraform.workspace]}"
  name                   = "${var.db_name}"
  username               = "${var.db_user}"
  password               = "${var.db_password}"
  db_subnet_group_name   = "${aws_db_subnet_group.rds_subnet_group.id}"
  vpc_security_group_ids = ["${aws_security_group.sg_db_5432_ingress.id}"]

  skip_final_snapshot    = true

}