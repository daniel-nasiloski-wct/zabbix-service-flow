<?php declare(strict_types = 1);

namespace Modules\ServiceDashboard\Includes;

/**
 * Cache compartilhado de 30 s em sys_get_temp_dir(): não importa quantos navegadores estejam abertos,
 * a coleta roda no máximo uma vez por janela e por "visão". Requisições simultâneas esperam a mesma
 * coleta (flock), em vez de todas irem ao ClickHouse. Perder o diretório temporário (restart do
 * php-fpm) custa só uma coleta a mais.
 */
class CCache {

	public const TTL = 30;
	private const PREFIX = 'zbx-servicedashboard-';

	/**
	 * @param callable(): array $collect Produz o payload quando o cache está vencido.
	 *
	 * @return string JSON pronto para enviar.
	 */
	public static function get(string $signature, int $minutes, callable $collect): string {
		$file = self::dir().'/'.self::PREFIX.preg_replace('/[^a-z0-9]/i', '', $signature).'-'.$minutes.'.json';

		$cached = self::fresh($file);
		if ($cached !== null) {
			return $cached;
		}

		return self::exclusive(static function () use ($file, $collect): string {
			$cached = self::fresh($file);
			if ($cached !== null) {
				return $cached;
			}
			$json = json_encode($collect(), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
			if ($json === false) {
				throw new \RuntimeException('Cannot encode the service map: '.json_last_error_msg());
			}
			$tmp = $file.'.'.getmypid().'.tmp';
			if (@file_put_contents($tmp, $json) !== false) {
				@chmod($tmp, 0600);
				@rename($tmp, $file);
			}

			return $json;
		});
	}

	/** Executa $fn segurando o lock do módulo (coleta e remoções não se atropelam). */
	public static function exclusive(callable $fn) {
		$lock = @fopen(self::dir().'/'.self::PREFIX.'lock', 'c');
		if ($lock === false) {
			return $fn();
		}
		try {
			@flock($lock, LOCK_EX);

			return $fn();
		}
		finally {
			@flock($lock, LOCK_UN);
			fclose($lock);
		}
	}

	public static function invalidateAll(): void {
		foreach (glob(self::dir().'/'.self::PREFIX.'*.json') ?: [] as $file) {
			@unlink($file);
		}
	}

	private static function fresh(string $file): ?string {
		clearstatcache(true, $file);
		if (!is_file($file) || time() - (int) filemtime($file) >= self::TTL) {
			return null;
		}
		$json = @file_get_contents($file);

		return ($json !== false && $json !== '') ? $json : null;
	}

	private static function dir(): string {
		return rtrim(sys_get_temp_dir(), '/');
	}
}
