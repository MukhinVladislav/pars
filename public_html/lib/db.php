<?php
require_once __DIR__ . '/config.php';

final class DB
{
    private static ?PDO $dbh = null;

    public static function getDbh(): PDO
    {
        if (self::$dbh instanceof PDO) {
            return self::$dbh;
        }

        $dsn  = getenv('YT_DB_DSN')  ?: (DB_DSN  !== '' ? DB_DSN  : DB_DSN_DEFAULT);
        $user = getenv('YT_DB_USER') ?: (DB_USER !== '' ? DB_USER : DB_USER_DEFAULT);
        $pass = getenv('YT_DB_PASS') ?: (DB_PASS !== '' ? DB_PASS : DB_PASS_DEFAULT);

        try {
            self::$dbh = new PDO(
                $dsn,
                $user,
                $pass,
                [
                    PDO::MYSQL_ATTR_INIT_COMMAND => "SET NAMES 'utf8'",
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                ]
            );
        } catch (PDOException $e) {
            http_response_code(500);
            header('Content-Type: text/plain; charset=utf-8');
            echo 'DB connection error';
            exit;
        }

        return self::$dbh;
    }

    public static function set(string $query, array $param = []): bool
    {
        $sth = self::getDbh()->prepare($query);
        return $sth->execute($param);
    }

    public static function add(string $query, array $param = []): string
    {
        $sth = self::getDbh()->prepare($query);
        $ok = $sth->execute($param);
        return $ok ? self::getDbh()->lastInsertId() : '0';
    }

    public static function getRow(string $query, array $param = []): ?array
    {
        $sth = self::getDbh()->prepare($query);
        $sth->execute($param);
        $row = $sth->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public static function getAll(string $query, array $param = []): array
    {
        $sth = self::getDbh()->prepare($query);
        $sth->execute($param);
        return $sth->fetchAll(PDO::FETCH_ASSOC);
    }

    public static function beginTransaction(): void
    {
        self::getDbh()->beginTransaction();
    }

    public static function commit(): void
    {
        self::getDbh()->commit();
    }

    public static function rollBack(): void
    {
        if (self::getDbh()->inTransaction()) {
            self::getDbh()->rollBack();
        }
    }

    public static function getStructure(string $table): array
    {
        $res = [];
        foreach (self::getAll("SHOW COLUMNS FROM {$table}") as $row) {
            $res[$row['Field']] = true;
        }
        return $res;
    }
}
